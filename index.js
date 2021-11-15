// Import the [pulumi/aws](https://pulumi.io/reference/pkg/nodejs/@pulumi/aws/index.html) package
const pulumi = require("@pulumi/pulumi");
const aws = require("@pulumi/aws");
const awsx = require("@pulumi/awsx");

const prefix = `${pulumi.getProject()}-${pulumi.getStack()}-`;

const drawsTable = new aws.dynamodb.Table(prefix + "draws", {
    attributes: [
        { name: "DrawId", type: "S" },
        { name: "EntryNum", type: "N" },
    ],
    hashKey: "DrawId",
    rangeKey: "EntryNum",
    billingMode: "PAY_PER_REQUEST"
});

const region = pulumi.output(aws.getRegion());

// Create a public HTTP endpoint (using AWS APIGateway)
const endpoint = new awsx.apigateway.API(prefix + "api", {
    staticRoutesBucket: new aws.s3.Bucket(prefix + "www"),
    routes: [
        // Serve static files from the `www` folder (using AWS S3)
        {
            path: "/",
            localPath: "www",
        },
        {
            path: "/e",
            localPath: "www/entry.html",
        },

        // Serve a simple REST API using AWS Lambda
        {
            path: "/draws",
            method: "POST",
            eventHandler: new aws.lambda.CallbackFunction(prefix + "draws-post", {
                callback: async event => {
                    const AWS = require('aws-sdk');
                    const uuid = require('uuid');

                    AWS.config.update({ region: region.get().id });
                    const db = new AWS.DynamoDB.DocumentClient();

                    const buff = Buffer.from(event.body, "base64");
                    const eventBodyStr = buff.toString('UTF-8');
                    const eventBody = JSON.parse(eventBodyStr);

                    const numRows = Math.min(10, eventBody.numRows) | 0;

                    const drawId = uuid.v4();

                    const putRequests = [];
                    for (let i = 0; i < numRows; i++) {
                        putRequests.push({
                            PutRequest: {
                                Item: {
                                    'DrawId': drawId,
                                    'EntryNum': i,
                                    'Version': 1,
                                    'Seen': false,
                                    'DrawnName': 'Chri'
                                }
                            }
                        });
                    }
                    const batchWriteParams = {
                        RequestItems: {
                            [drawsTable.name.get()]: putRequests
                        }
                    };
                    await db.batchWrite(batchWriteParams).promise();

                    return {
                        statusCode: 200,
                        body: JSON.stringify({
                            path: "e?d=" + drawId + "&n=0",
                        }),
                        headers: { "content-type": "application/json" },
                    };
                }
            }),
        },
        {
            path: "/draws/{drawId}/entries/{entryNum}",
            method: "GET", // TODO: add a post method and don't return the name in this one.
            eventHandler: new aws.lambda.CallbackFunction(prefix + "entries-get", {
                callback: async event => {
                    const AWS = require('aws-sdk');

                    AWS.config.update({ region: region.get().id });
                    const db = new AWS.DynamoDB.DocumentClient();

                    const drawId = event.pathParameters.drawId;
                    const entryNum = Number(event.pathParameters.entryNum);

                    // https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/DynamoDB/DocumentClient.html#query-property
                    const params = {
                        TableName: drawsTable.name.get(),
                        KeyConditionExpression: 'DrawId = :hkey and EntryNum = :rkey',
                        ExpressionAttributeValues: {
                          ':hkey': drawId,
                          ':rkey': entryNum,
                        },
                        ProjectionExpression: 'DrawnName',
                        Limit: 1,
                      };
                    console.log("params: ", params);
                    const data = await db.query(params).promise();
                    const item = data.Items[0];

                    return {
                        statusCode: 200,
                        body: JSON.stringify({ name: item.DrawnName }),
                        headers: { "content-type": "application/json" },
                    };
                }
            }),
        },
    ],
});

// Export the public URL for the HTTP service
exports.url = endpoint.url;

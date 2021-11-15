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

        // Serve a simple REST API on `GET /name` (using AWS Lambda)
        {
            path: "/draws",
            method: "POST",
            eventHandler: new aws.lambda.CallbackFunction(prefix + "lambda", {
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
                        body: JSON.stringify({ name: "AWS" }),
                        headers: { "content-type": "application/json" },
                    };
                }
            }),
        },
    ],
});

// Export the public URL for the HTTP service
exports.url = endpoint.url;

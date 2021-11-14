// Import the [pulumi/aws](https://pulumi.io/reference/pkg/nodejs/@pulumi/aws/index.html) package
const pulumi = require("@pulumi/pulumi");
const aws = require("@pulumi/aws");
const awsx = require("@pulumi/awsx");

const prefix = `${pulumi.getProject()}-${pulumi.getStack()}-`;

const db = new aws.dynamodb.Table(prefix + "db", {
    attributes: [
        { name: "Id", type: "S" },
    ],
    hashKey: "Id",
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
                    AWS.config.update({ region: region.get().id });
                    const ddb = new AWS.DynamoDB({ apiVersion: '2012-08-10' });

                    const buff = Buffer.from(event.body, "base64");
                    const eventBodyStr = buff.toString('UTF-8');
                    const eventBody = JSON.parse(eventBodyStr);

                    const putItemParams = {
                        TableName: db.name.get(),
                        Item: {
                            'Id': { S: eventBody.name }
                        }
                    };
                    console.log("putItemParams:", putItemParams);
                    await ddb.putItem(putItemParams).promise();

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

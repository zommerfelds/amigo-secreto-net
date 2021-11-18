const pulumi = require("@pulumi/pulumi");
const aws = require("@pulumi/aws");
const awsx = require("@pulumi/awsx");

const prefix = `${pulumi.getProject()}-${pulumi.getStack()}-`;
const region = pulumi.output(aws.getRegion());
const domainName = (pulumi.getStack() == "prod") ? "amigo-secreto.net" : null;

const drawsTable = new aws.dynamodb.Table(prefix + "draws", {
    attributes: [
        { name: "DrawId", type: "S" },
        { name: "EntryNum", type: "N" },
    ],
    hashKey: "DrawId",
    rangeKey: "EntryNum",
    billingMode: "PAY_PER_REQUEST"
});

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
                    const sanitizeHtml = require('sanitize-html');

                    AWS.config.update({ region: region.get().id });
                    const db = new AWS.DynamoDB.DocumentClient();

                    const buff = Buffer.from(event.body, "base64");
                    const eventBodyStr = buff.toString('UTF-8');
                    const eventBody = JSON.parse(eventBodyStr);

                    const numRows = Math.min(10, eventBody.names.length) | 0;

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
                                    'DrawnName': 'TODO',
                                    'IntendedViewer': sanitizeHtml(eventBody.names[i]),
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

                    var outputEntries = [];
                    for (var i = 0; i < numRows; i++) {
                        outputEntries.push({
                            name: eventBody.names[i],
                            path: "e?d=" + drawId + "&n=" + i,
                        });
                    }

                    return {
                        statusCode: 200,
                        body: JSON.stringify({
                            entries: outputEntries
                        }),
                        headers: { "content-type": "application/json" },
                    };
                }
            }),
        },
        {
            path: "/draws/{drawId}/entries/{entryNum}",
            method: "GET",
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
                        ProjectionExpression: 'IntendedViewer, Seen',
                        Limit: 1,
                    };
                    console.log("params: ", params);
                    const data = await db.query(params).promise();
                    console.log("Data: ", data);
                    const item = data.Items[0];

                    return {
                        statusCode: 200,
                        body: JSON.stringify({
                            viewer: item.IntendedViewer,
                            seen: item.Seen,
                        }),
                        headers: { "content-type": "application/json" },
                    };
                }
            }),
        },
        {
            path: "/draws/{drawId}/entries/{entryNum}/reveal",
            method: "POST",
            eventHandler: new aws.lambda.CallbackFunction(prefix + "entries-reveal-post", {
                callback: async event => {
                    const AWS = require('aws-sdk');

                    AWS.config.update({ region: region.get().id });
                    const db = new AWS.DynamoDB.DocumentClient();

                    const drawId = event.pathParameters.drawId;
                    const entryNum = Number(event.pathParameters.entryNum);

                    const params = {
                        TableName: drawsTable.name.get(),
                        Key: {
                            DrawId: drawId,
                            EntryNum: entryNum,
                        },
                        UpdateExpression: 'set Seen = :true',
                        ExpressionAttributeValues: {
                            ":true": true,
                            ":false": false,
                        },
                        ConditionExpression: 'Seen = :false',
                        ReturnValues: 'ALL_NEW'
                    };
                    console.log("params: ", params);
                    var data;
                    try {
                        data = await db.update(params).promise();
                        console.log("Data: ", data);
                    } catch (e) {
                        if (e.code == "ConditionalCheckFailedException") {

                            return {
                                statusCode: 400,
                                body: JSON.stringify({
                                    reason: "ALREADY_DRAWN",
                                }),
                                headers: { "content-type": "application/json" },
                            };
                        } else {
                            throw e;
                        }
                    }

                    return {
                        statusCode: 200,
                        body: JSON.stringify({
                            drawnName: data.Attributes.DrawnName,
                        }),
                        headers: { "content-type": "application/json" },
                    };
                }
            }),
        },
    ],
});

if (domainName != null) {
    const route53ZoneId = aws.route53.getZone({
        name: domainName,
        privateZone: false,
    }).then(r => r.id);

    const cert = new aws.acm.Certificate(prefix + "cert", {
        domainName: domainName,
        validationMethod: "EMAIL",
    });
    // Note: need to check emails during "pulumi up"
    new aws.acm.CertificateValidation(prefix + "cert-validation", { certificateArn: cert.arn });

    const apiGatewayDomainName = new aws.apigateway.DomainName(prefix + "domain", {
        certificateArn: cert.arn,
        domainName: domainName,
    });

    const record = new aws.route53.Record(prefix + "record", {
        name: domainName,
        type: "A",
        zoneId: route53ZoneId,
        aliases: [{
            evaluateTargetHealth: true,
            name: apiGatewayDomainName.cloudfrontDomainName,
            zoneId: apiGatewayDomainName.cloudfrontZoneId,
        }],
    });

    /*
    TODO: It would be good to setup a 301 redirect for www.
    new aws.route53.Record(prefix + "record-www", {
        name: "www." + domainName,
        type: "CNAME",
        zoneId: route53ZoneId,
        records: [
            domainName + "."
        ],
        ttl: 3600,
    });
    */

    // WARNING: I had to manually go to 
    // https://console.aws.amazon.com/apigateway/main/publish/domain-names/api-mappings?domain=amigo-secreto.net&region=us-east-1
    // and add the stage name. Somehow it didn't work via Pulumi.
    const basePathMapping = new aws.apigateway.BasePathMapping(prefix + "mapping", {
        restApi: endpoint.restAPI.id,
        stageName: endpoint.stage.stageName,
        domainName: domainName,
    });
}

// Export the public URL for the HTTP service
exports.url = endpoint.url;

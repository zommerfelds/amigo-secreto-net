const pulumi = require("@pulumi/pulumi");
const aws = require("@pulumi/aws");
const awsx = require("@pulumi/awsx");

const prefix = `${pulumi.getProject()}-${pulumi.getStack()}-`;
const region = pulumi.output(aws.getRegion());
const domainName = (pulumi.getStack() == "prod") ? "amigo-secreto.net" : null;

const drawsTable = new aws.dynamodb.Table(prefix + "draws", {
    attributes: [
        { name: "EntryId", type: "S" },
    ],
    hashKey: "EntryId",
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
            path: "/api/draws",
            method: "POST",
            eventHandler: new aws.lambda.CallbackFunction(prefix + "draws-post", {
                callback: async event => {
                    const AWS = require('aws-sdk');
                    const nanoid = require('nanoid');
                    const sanitizeHtml = require('sanitize-html');

                    AWS.config.update({ region: region.get().id });
                    const db = new AWS.DynamoDB.DocumentClient();

                    const buff = Buffer.from(event.body, "base64");
                    const eventBodyStr = buff.toString('UTF-8');
                    const eventBody = JSON.parse(eventBodyStr);

                    const numRows = Math.min(100, eventBody.names.length) | 0;

                    const drawId = nanoid.nanoid();
                    const entryIds = [];
                    const names = [];
                    for (var i = 0; i < numRows; i++) {
                        entryIds.push(nanoid.nanoid());
                        names.push(sanitizeHtml(eventBody.names[i]));
                    }

                    const drawnIndices = []; // 1 -> 0

                    const remaining = [...Array(numRows).keys()]; // [0, 1, 2]
                    let chainStart = null; // 1
                    let current = null; // 0
                    while (remaining.length > 0) {
                        const nextDrawI = Math.floor(Math.random() * remaining.length); // 0
                        const nextDraw = remaining[nextDrawI];
                        console.log('r:', remaining, 'n:', nextDraw, 'i:', drawnIndices);
                        if (chainStart == null) {
                            chainStart = nextDraw;
                            current = nextDraw;
                        } else {
                            drawnIndices[current] = nextDraw;
                            current = nextDraw;
                            remaining.splice(nextDrawI, 1);
                            if (chainStart == current) {
                                chainStart = null;
                            }
                        }
                    }

                    const putRequests = [];
                    for (let i = 0; i < numRows; i++) {
                        putRequests.push({
                            PutRequest: {
                                Item: {
                                    'DrawId': drawId,
                                    'EntryId': entryIds[i],
                                    'Version': 1,
                                    'Seen': false,
                                    'DrawnName': names[drawnIndices[i]],
                                    'IntendedViewer': names[i],
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
                            name: names[i],
                            path: "e?i=" + entryIds[i],
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
            path: "/api/entries/{entryId}",
            method: "GET",
            eventHandler: new aws.lambda.CallbackFunction(prefix + "entries-get", {
                callback: async event => {
                    const AWS = require('aws-sdk');

                    AWS.config.update({ region: region.get().id });
                    const db = new AWS.DynamoDB.DocumentClient();

                    // https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/DynamoDB/DocumentClient.html#query-property
                    const params = {
                        TableName: drawsTable.name.get(),
                        KeyConditionExpression: 'EntryId = :eid',
                        ExpressionAttributeValues: {
                            ':eid': event.pathParameters.entryId,
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
            path: "/api/entries/{entryId}/reveal",
            method: "POST",
            eventHandler: new aws.lambda.CallbackFunction(prefix + "entries-reveal-post", {
                callback: async event => {
                    const AWS = require('aws-sdk');

                    AWS.config.update({ region: region.get().id });
                    const db = new AWS.DynamoDB.DocumentClient();

                    const params = {
                        TableName: drawsTable.name.get(),
                        Key: {
                            EntryId: event.pathParameters.entryId,
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

    const basePathMapping = new aws.apigateway.BasePathMapping(prefix + "mapping", {
        restApi: endpoint.restAPI.id,
        stageName: endpoint.stage.stageName,
        domainName: domainName,
    });
}

// Export the public URL for the HTTP service
exports.url = endpoint.url;

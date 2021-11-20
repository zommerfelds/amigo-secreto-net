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

function makeSuccessfulResponse(json) {
    return {
        statusCode: 200,
        body: JSON.stringify(json),
        headers: { "content-type": "application/json" },
    };
}
function makeErrorResponse(reason, status) {
    reason = reason || "ERROR";
    status = status || 400;

    return {
        statusCode: status,
        body: JSON.stringify({
            reason: reason,
        }),
        headers: { "content-type": "application/json" },
    };
}

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

                    if (!eventBody.names || eventBody.names.length > 100 || new Set(eventBody.names).size != eventBody.names.length) {
                        return makeErrorResponse("INVALID_INPUT");
                    }
                    const groups = eventBody.groups || [...Array(eventBody.names.length).keys()];
                    if (groups.length != eventBody.names.length) {
                        return makeErrorResponse("INVALID_INPUT");
                    }

                    const drawId = nanoid.nanoid();
                    const entryIds = [];
                    const users = [];
                    for (var i = 0; i < eventBody.names.length; i++) {
                        entryIds.push(nanoid.nanoid());
                        users.push({
                            name: sanitizeHtml(eventBody.names[i]),
                            group: groups[i],
                        });
                    }

                    let drawnIndices = [];

                    for (let attempts = 0;; attempts++) {
                        if (attempts > 100) {
                            // This may happen if the user input an impossible to solve draw.
                            return makeErrorResponse("TOO_MANY_ATTEMPTS");
                        }

                        drawnIndices = [];
                        const remaining = [...Array(users.length).keys()];
                        let chainStart = null;
                        let current = null;
                        while (remaining.length > 0) {
                            if (chainStart == null) {
                                chainStart = remaining[Math.floor(Math.random() * remaining.length)];
                                current = chainStart;
                            } else {
                                const candidates = remaining.filter(r => users[r].group != users[current].group);
                                if (candidates.length == 0) break;
                                const draw = candidates[Math.floor(Math.random() * candidates.length)];
                                drawnIndices[current] = draw;
                                current = draw;
                                remaining.splice(remaining.indexOf(draw), 1);
                                if (chainStart == current) {
                                    chainStart = null;
                                }
                            }
                        }
                        if (remaining.length == 0) break;
                    }

                    if (new Set(drawnIndices).size != users.length) {
                        // Assert that draw is valid.
                        // Note: this should rather be done in a unit test.
                        throw new Error("post-condition check failed");
                    }

                    const putRequests = [];
                    for (let i = 0; i < users.length; i++) {
                        putRequests.push({
                            PutRequest: {
                                Item: {
                                    'DrawId': drawId,
                                    'EntryId': entryIds[i],
                                    'Version': 1,
                                    'DrawnName': users[drawnIndices[i]].name,
                                    'IntendedViewer': users[i].name,
                                    'Created': Date.now()
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
                    for (var i = 0; i < users.length; i++) {
                        outputEntries.push({
                            name: users[i].name,
                            path: "e?i=" + entryIds[i],
                        });
                    }

                    return makeSuccessfulResponse({
                        entries: outputEntries
                    });
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

                    return makeSuccessfulResponse({
                        viewer: item.IntendedViewer,
                        seen: item.Seen,
                    });
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
                        UpdateExpression: 'set Seen = :time',
                        ExpressionAttributeValues: {
                            ":time": Date.now(),
                        },
                        ConditionExpression: 'attribute_not_exists(Seen)',
                        ReturnValues: 'ALL_NEW'
                    };
                    console.log("params: ", params);
                    var data;
                    try {
                        data = await db.update(params).promise();
                        console.log("Data: ", data);
                    } catch (e) {
                        if (e.code == "ConditionalCheckFailedException") {
                            return makeErrorResponse("ALREADY_DRAWN");
                        } else {
                            throw e;
                        }
                    }

                    return makeSuccessfulResponse({
                        drawnName: data.Attributes.DrawnName,
                    });
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

    new aws.route53.Record(prefix + "record", {
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

    new aws.apigateway.BasePathMapping(prefix + "mapping", {
        restApi: endpoint.restAPI.id,
        stageName: endpoint.stage.stageName,
        domainName: domainName,
    });
}

// Export the public URL for the HTTP service
exports.url = endpoint.url;

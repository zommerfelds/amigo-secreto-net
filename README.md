# amigo-secreto-net
Secret santa naming drawing service in Portuguese.

NOTE: this is a work in progress!

[amigo-secreto.net](https://amigo-secreto.net)

## TODO

[] Bug: when name is empty it should be ignored
[] List possible next features here and rank them
[] Put ads?

## Development

[![Open in Gitpod](https://gitpod.io/button/open-in-gitpod.svg)](https://gitpod.io/#https://github.com/zommerfelds/amigo-secreto-net)

If setting up for the first time, the following variables should be set in Gitpod:
```
gp env AWS_ACCESS_KEY_ID=xxx
gp env AWS_SECRET_ACCESS_KEY=xxx
gp env PULUMI_ACCESS_TOKEN=xxx
```

The AWS user should work with the following permissions:
```
IAMFullAccess
AmazonS3FullAccess
AmazonAPIGatewayInvokeFullAccess
AmazonDynamoDBFullAccess
CloudFrontFullAccess
AmazonAPIGatewayAdministrator
AmazonRoute53FullAccess
AWSCertificateManagerFullAccess
AWSLambda_FullAccess
```
(There are probably some that can be narrowed down.)

Starting the stack:
```
pulumi up --stack dev --yes
```

For only previewing HTML files, without the backend:
```
yarn run ui
```
Note that auto-reload dosn't work on the root path (need to add `/index.html`). Click on the printed link.

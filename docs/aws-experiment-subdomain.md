# AWS experiment subdomain

`aws.giuliovaccari.it` is delegated from Squarespace/Google DNS to Route 53 so
AWS-hosted experiments can use subdomains without editing Squarespace each time.

## Route 53 hosted zone

- Zone name: `aws.giuliovaccari.it`
- Hosted zone ID: `Z08788173CZC2PM1CQDUQ`
- AWS account: `854656252703`

Squarespace/Google DNS must contain NS records for host/name `aws`:

```text
ns-852.awsdns-42.net
ns-1508.awsdns-60.org
ns-1537.awsdns-00.co.uk
ns-240.awsdns-30.com
```

After those records propagate, Route 53 controls everything under:

```text
*.aws.giuliovaccari.it
```

## Wildcard certificate

CloudFront-compatible ACM certificate in `us-east-1`:

```text
arn:aws:acm:us-east-1:854656252703:certificate/d8ee417b-e7e9-45f6-a008-07a3cf631483
```

Covers:

```text
*.aws.giuliovaccari.it
aws.giuliovaccari.it
```

The ACM validation CNAME is already created inside the Route 53 zone. The cert
will issue only after the parent domain delegates `aws.giuliovaccari.it` to the
Route 53 nameservers above.

## CDK pattern

For CloudFront apps, pass:

```bash
-c domainName=<app>.aws.giuliovaccari.it \
-c hostedZoneName=aws.giuliovaccari.it \
-c hostedZoneId=Z08788173CZC2PM1CQDUQ \
-c certificateArn=arn:aws:acm:us-east-1:854656252703:certificate/d8ee417b-e7e9-45f6-a008-07a3cf631483
```

Polyautomate uses equivalent prefixed context names:

```bash
-c portfolioDomainName=polybot.aws.giuliovaccari.it \
-c portfolioHostedZoneName=aws.giuliovaccari.it \
-c portfolioHostedZoneId=Z08788173CZC2PM1CQDUQ \
-c portfolioCertificateArn=arn:aws:acm:us-east-1:854656252703:certificate/d8ee417b-e7e9-45f6-a008-07a3cf631483
```

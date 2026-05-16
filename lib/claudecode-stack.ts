import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export class ClaudeCodeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = ec2.Vpc.fromLookup(this, 'DefaultVpc', { isDefault: true });

    // ── ECR ──────────────────────────────────────────────────────────────
    const repo = new ecr.Repository(this, 'BridgeRepo', {
      repositoryName: 'claudecode-bridge',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [{ maxImageCount: 5 }],
    });

    // ── ECS cluster ───────────────────────────────────────────────────────
    const cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: 'claudecode',
      vpc,
      containerInsights: false,
    });

    // ── DynamoDB ──────────────────────────────────────────────────────────
    // chatId → { taskArn, privateIp, status, efsAccessPointId, createdAt }
    const usersTable = new dynamodb.Table(this, 'UsersTable', {
      tableName: 'claudecode-users',
      partitionKey: { name: 'chatId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ── S3 bucket for user session credentials ────────────────────────────
    const sessionsBucket = new s3.Bucket(this, 'SessionsBucket', {
      bucketName: `claudecode-sessions-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ── Security groups ───────────────────────────────────────────────────
    const taskSg = new ec2.SecurityGroup(this, 'TaskSg', {
      vpc,
      securityGroupName: 'claudecode-task-sg',
      description: 'claudecode Fargate user tasks',
      allowAllOutbound: true,
    });
    // Port 3000 reachable from within the VPC (routing bot lives here too)
    taskSg.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(3000),
      'Bridge HTTP from VPC',
    );

    // ── IAM ───────────────────────────────────────────────────────────────
    // Task execution role (ECS infrastructure — ECR pull, CloudWatch logs)
    const executionRole = iam.Role.fromRoleName(this, 'ExecRole', 'ecsTaskExecutionRole');

    // Task role (what running container can do)
    const taskRole = new iam.Role(this, 'TaskRole', {
      roleName: 'claudecode-task-role',
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    usersTable.grantWriteData(taskRole);
    sessionsBucket.grantReadWrite(taskRole);
    taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/claudecode/tasks:*`],
    }));

    // ── CloudWatch log group ──────────────────────────────────────────────
    const logGroup = new logs.LogGroup(this, 'TaskLogs', {
      logGroupName: '/claudecode/tasks',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── Base task definition ──────────────────────────────────────────────
    // USER_CHAT_ID env override is applied at RunTask time per user.
    const taskDef = new ecs.FargateTaskDefinition(this, 'BaseTaskDef', {
      family: 'claudecode-user',
      cpu: 512,
      memoryLimitMiB: 1024,
      taskRole,
      executionRole,
      // Use ARM64 (Graviton) — cheaper and matches this EC2's architecture
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    taskDef.addContainer('bridge', {
      image: ecs.ContainerImage.fromEcrRepository(repo, 'latest'),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'bridge',
        logGroup,
      }),
      environment: {
        DYNAMO_TABLE: usersTable.tableName,
        S3_BUCKET: sessionsBucket.bucketName,
        AWS_REGION: this.region,
      },
      portMappings: [{ containerPort: 3000, protocol: ecs.Protocol.TCP }],
    });

    // ── Web page: S3 + CloudFront ─────────────────────────────────────────
    const webBucket = new s3.Bucket(this, 'WebBucket', {
      bucketName: `claudecode-web-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const distribution = new cloudfront.Distribution(this, 'WebDistribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(webBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      defaultRootObject: 'index.html',
      errorResponses: [
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' },
      ],
    });

    new s3deploy.BucketDeployment(this, 'WebDeploy', {
      sources: [s3deploy.Source.asset('./web')],
      destinationBucket: webBucket,
      distribution,
      distributionPaths: ['/*'],
    });

    // ── Outputs ───────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'ClusterArn', {
      exportName: 'claudecode-cluster-arn',
      value: cluster.clusterArn,
    });
    new cdk.CfnOutput(this, 'UsersTableName', {
      exportName: 'claudecode-users-table',
      value: usersTable.tableName,
    });
    new cdk.CfnOutput(this, 'SessionsBucket', {
      exportName: 'claudecode-sessions-bucket',
      value: sessionsBucket.bucketName,
    });
    new cdk.CfnOutput(this, 'TaskSgId', {
      exportName: 'claudecode-task-sg-id',
      value: taskSg.securityGroupId,
    });
    new cdk.CfnOutput(this, 'RepoUri', {
      exportName: 'claudecode-repo-uri',
      value: repo.repositoryUri,
    });
    new cdk.CfnOutput(this, 'WebUrl', {
      exportName: 'claudecode-web-url',
      value: `https://${distribution.distributionDomainName}`,
    });
    new cdk.CfnOutput(this, 'TaskRoleArn', {
      exportName: 'claudecode-task-role-arn',
      value: taskRole.roleArn,
    });
  }
}

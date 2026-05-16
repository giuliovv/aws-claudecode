import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as efs from 'aws-cdk-lib/aws-efs';
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

    // ── EFS ───────────────────────────────────────────────────────────────
    const efsFs = new efs.FileSystem(this, 'UserDataEfs', {
      vpc,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_30_DAYS,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.BURSTING,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      enableAutomaticBackups: false,
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
    efsFs.connections.allowDefaultPortFrom(taskSg, 'EFS from task SG');

    // ── IAM ───────────────────────────────────────────────────────────────
    // Task execution role (ECS infrastructure — ECR pull, CloudWatch logs)
    const executionRole = iam.Role.fromRoleName(this, 'ExecRole', 'ecsTaskExecutionRole');

    // Task role (what running container can do)
    const taskRole = new iam.Role(this, 'TaskRole', {
      roleName: 'claudecode-task-role',
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    usersTable.grantWriteData(taskRole);
    // Allow container to describe its own task (to get private IP)
    taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['ecs:DescribeTasks'],
      resources: ['*'],
    }));

    // ── CloudWatch log group ──────────────────────────────────────────────
    const logGroup = new logs.LogGroup(this, 'TaskLogs', {
      logGroupName: '/claudecode/tasks',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── Base task definition ──────────────────────────────────────────────
    // Per-user task defs are registered at provision time (different EFS access point).
    // This base def is used for reference and by the provision script as a template.
    const taskDef = new ecs.FargateTaskDefinition(this, 'BaseTaskDef', {
      family: 'claudecode-user',
      cpu: 512,
      memoryLimitMiB: 1024,
      taskRole,
      executionRole,
    });

    taskDef.addVolume({
      name: 'user-data',
      efsVolumeConfiguration: {
        fileSystemId: efsFs.fileSystemId,
        transitEncryption: 'ENABLED',
        authorizationConfig: { iam: 'ENABLED' },
      },
    });

    const container = taskDef.addContainer('bridge', {
      image: ecs.ContainerImage.fromEcrRepository(repo, 'latest'),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'bridge',
        logGroup,
      }),
      environment: {
        DYNAMO_TABLE: usersTable.tableName,
        AWS_REGION: this.region,
        DATA_DIR: '/data',
        EFS_FS_ID: efsFs.fileSystemId,
      },
      portMappings: [{ containerPort: 3000, protocol: ecs.Protocol.TCP }],
    });

    container.addMountPoints({
      sourceVolume: 'user-data',
      containerPath: '/data',
      readOnly: false,
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
    new cdk.CfnOutput(this, 'EfsId', {
      exportName: 'claudecode-efs-id',
      value: efsFs.fileSystemId,
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

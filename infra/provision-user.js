'use strict';
/**
 * Provisions a per-user EFS access point and Fargate task.
 * Called by the router bot when a new user appears.
 * Reads stack outputs from environment variables set at deploy time.
 */
const { EFSClient, CreateAccessPointCommand } = require('@aws-sdk/client-efs');
const { ECSClient, RegisterTaskDefinitionCommand, RunTaskCommand, DescribeTasksCommand } = require('@aws-sdk/client-ecs');

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const ECS_CLUSTER = process.env.ECS_CLUSTER || 'claudecode';
const EFS_FS_ID = process.env.EFS_FS_ID || '';
const SUBNET_IDS = (process.env.SUBNET_IDS || '').split(',').filter(Boolean);
const TASK_SG_ID = process.env.TASK_SG_ID || '';
const REPO_URI = process.env.REPO_URI || '';
const DYNAMO_TABLE = process.env.DYNAMO_TABLE || 'claudecode-users';
const TASK_ROLE_ARN = process.env.TASK_ROLE_ARN || '';
const EXEC_ROLE_ARN = process.env.EXEC_ROLE_ARN || 'arn:aws:iam::854656252703:role/ecsTaskExecutionRole';
const ACCOUNT_ID = process.env.ACCOUNT_ID || '854656252703';

const efs = new EFSClient({ region: AWS_REGION });
const ecs = new ECSClient({ region: AWS_REGION });

/**
 * Creates an EFS access point for the user and registers + runs a task definition.
 * Returns { taskArn, efsAccessPointId }.
 */
async function provisionUser(chatId) {
  const cid = String(chatId);

  // 1. Create an EFS access point scoped to this user's directory
  const ap = await efs.send(new CreateAccessPointCommand({
    FileSystemId: EFS_FS_ID,
    PosixUser: { Uid: 1000, Gid: 1000 },
    RootDirectory: {
      Path: `/users/${cid}`,
      CreationInfo: { OwnerUid: 1000, OwnerGid: 1000, Permissions: '755' },
    },
    Tags: [
      { Key: 'claudecode:chatId', Value: cid },
      { Key: 'Name', Value: `claudecode-user-${cid}` },
    ],
  }));
  const apId = ap.AccessPointId;
  console.log(`Created EFS access point ${apId} for chatId ${cid}`);

  // 2. Register a task definition with this user's EFS access point
  const taskDef = await ecs.send(new RegisterTaskDefinitionCommand({
    family: 'claudecode-user',
    networkMode: 'awsvpc',
    requiresCompatibilities: ['FARGATE'],
    cpu: '512',
    memory: '1024',
    taskRoleArn: TASK_ROLE_ARN,
    executionRoleArn: EXEC_ROLE_ARN,
    volumes: [{
      name: 'user-data',
      efsVolumeConfiguration: {
        fileSystemId: EFS_FS_ID,
        transitEncryption: 'ENABLED',
        authorizationConfig: {
          accessPointId: apId,
          iam: 'ENABLED',
        },
      },
    }],
    containerDefinitions: [{
      name: 'bridge',
      image: `${REPO_URI}:latest`,
      essential: true,
      portMappings: [{ containerPort: 3000, protocol: 'tcp' }],
      environment: [
        { name: 'USER_CHAT_ID', value: cid },
        { name: 'DYNAMO_TABLE', value: DYNAMO_TABLE },
        { name: 'AWS_REGION', value: AWS_REGION },
        { name: 'DATA_DIR', value: '/data' },
      ],
      mountPoints: [{
        sourceVolume: 'user-data',
        containerPath: '/data',
        readOnly: false,
      }],
      logConfiguration: {
        logDriver: 'awslogs',
        options: {
          'awslogs-group': '/claudecode/tasks',
          'awslogs-region': AWS_REGION,
          'awslogs-stream-prefix': `user-${cid}`,
        },
      },
      healthCheck: {
        command: ['CMD-SHELL', 'curl -f http://localhost:3000/health || exit 1'],
        interval: 30,
        timeout: 5,
        retries: 3,
        startPeriod: 15,
      },
    }],
  }));
  const taskDefArn = taskDef.taskDefinition.taskDefinitionArn;
  console.log(`Registered task definition ${taskDefArn}`);

  // 3. Run the Fargate task
  // Use first available subnet for simplicity
  const subnetId = SUBNET_IDS[Math.floor(Math.random() * SUBNET_IDS.length)];
  const run = await ecs.send(new RunTaskCommand({
    cluster: ECS_CLUSTER,
    taskDefinition: taskDefArn,
    launchType: 'FARGATE',
    count: 1,
    networkConfiguration: {
      awsvpcConfiguration: {
        subnets: [subnetId],
        securityGroups: [TASK_SG_ID],
        assignPublicIp: 'ENABLED', // needed for ECR/DynamoDB egress without NAT
      },
    },
    tags: [{ key: 'claudecode:chatId', value: cid }],
  }));

  const task = run.tasks?.[0];
  if (!task) throw new Error(`RunTask failed: ${JSON.stringify(run.failures)}`);

  console.log(`Started task ${task.taskArn} for chatId ${cid}`);
  return { taskArn: task.taskArn, efsAccessPointId: apId };
}

/**
 * Describes a running task and returns its private IP.
 * Returns null if task is not yet running.
 */
async function getContainerIp(clusterName, taskArn) {
  const res = await ecs.send(new DescribeTasksCommand({
    cluster: clusterName,
    tasks: [taskArn],
  }));
  const task = res.tasks?.[0];
  if (!task || task.lastStatus !== 'RUNNING') return null;
  const eni = task.attachments?.find((a) => a.type === 'ElasticNetworkInterface');
  const privateIp = eni?.details?.find((d) => d.name === 'privateIPv4Address')?.value;
  return privateIp || null;
}

module.exports = { provisionUser, getContainerIp };

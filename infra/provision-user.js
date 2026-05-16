'use strict';
/**
 * Provisions a Fargate task for a new user.
 * Credentials are persisted to S3 (no EFS needed).
 */
const { ECSClient, RunTaskCommand, DescribeTasksCommand } = require('@aws-sdk/client-ecs');

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const ECS_CLUSTER = process.env.ECS_CLUSTER || 'claudecode';
const TASK_DEFINITION = process.env.TASK_DEFINITION || 'claudecode-user';
const SUBNET_IDS = (process.env.SUBNET_IDS || '').split(',').filter(Boolean);
const TASK_SG_ID = process.env.TASK_SG_ID || '';
const REPO_URI = process.env.REPO_URI || '';
const DYNAMO_TABLE = process.env.DYNAMO_TABLE || 'claudecode-users';
const S3_BUCKET = process.env.S3_BUCKET || 'claudecode-sessions-854656252703';
const TASK_ROLE_ARN = process.env.TASK_ROLE_ARN || 'arn:aws:iam::854656252703:role/claudecode-task-role';
const EXEC_ROLE_ARN = process.env.EXEC_ROLE_ARN || 'arn:aws:iam::854656252703:role/ecsTaskExecutionRole';

const ecs = new ECSClient({ region: AWS_REGION });

/**
 * Registers a per-user task definition and starts a Fargate task.
 * Returns { taskArn }.
 */
async function provisionUser(chatId) {
  const cid = String(chatId);
  const subnetId = SUBNET_IDS[Math.floor(Math.random() * SUBNET_IDS.length)];

  const run = await ecs.send(new RunTaskCommand({
    cluster: ECS_CLUSTER,
    taskDefinition: TASK_DEFINITION,
    launchType: 'FARGATE',
    count: 1,
    networkConfiguration: {
      awsvpcConfiguration: {
        subnets: [subnetId],
        securityGroups: [TASK_SG_ID],
        assignPublicIp: 'ENABLED',
      },
    },
    overrides: {
      containerOverrides: [{
        name: 'bridge',
        environment: [
          { name: 'USER_CHAT_ID', value: cid },
          { name: 'DYNAMO_TABLE', value: DYNAMO_TABLE },
          { name: 'S3_BUCKET', value: S3_BUCKET },
          { name: 'AWS_REGION', value: AWS_REGION },
        ],
      }],
    },
    tags: [{ key: 'claudecode:chatId', value: cid }],
  }));

  const task = run.tasks?.[0];
  if (!task) throw new Error(`RunTask failed: ${JSON.stringify(run.failures)}`);
  console.log(`Started task ${task.taskArn} for chatId ${cid}`);
  return { taskArn: task.taskArn };
}

/**
 * Returns the private IP of a running task, or null if not yet running.
 */
async function getContainerIp(taskArn) {
  const res = await ecs.send(new DescribeTasksCommand({
    cluster: ECS_CLUSTER,
    tasks: [taskArn],
  }));
  const task = res.tasks?.[0];
  if (!task || task.lastStatus !== 'RUNNING') return null;
  const eni = task.attachments?.find((a) => a.type === 'ElasticNetworkInterface');
  return eni?.details?.find((d) => d.name === 'privateIPv4Address')?.value || null;
}

module.exports = { provisionUser, getContainerIp };

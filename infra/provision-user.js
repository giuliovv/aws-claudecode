'use strict';
/**
 * Provisions an ECS Service for a new user (replaces RunTask).
 * Credentials are persisted to S3 (no EFS needed).
 *
 * Service name: user-{chatId}
 * Start: UpdateService desiredCount:1 (create if not exists)
 * Stop:  UpdateService desiredCount:0
 */
const { ECSClient, CreateServiceCommand, UpdateServiceCommand, DescribeTasksCommand, ListTasksCommand } = require('@aws-sdk/client-ecs');

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const ECS_CLUSTER = process.env.ECS_CLUSTER || 'claudecode';
const TASK_DEFINITION = process.env.TASK_DEFINITION || 'claudecode-user';
const SUBNET_IDS = (process.env.SUBNET_IDS || 'subnet-00ef452a9147da192,subnet-0b799a4832af70f5b,subnet-01497e4f428a93b98').split(',').filter(Boolean);
const TASK_SG_ID = process.env.TASK_SG_ID || 'sg-09153aed24d329cbd';

const ecs = new ECSClient({ region: AWS_REGION });

/**
 * Starts the per-user ECS Service (creates it on first use).
 * The bridge container discovers its chatId from the ECS service name via
 * the task metadata endpoint, then registers itself in DynamoDB.
 * Returns { taskArn: '' } — router waits for DynamoDB, not taskArn.
 */
async function provisionUser(chatId) {
  const cid = String(chatId);
  const svcName = `user-${cid}`;

  try {
    await ecs.send(new UpdateServiceCommand({
      cluster: ECS_CLUSTER,
      service: svcName,
      desiredCount: 1,
    }));
    console.log(`Scaled up existing service ${svcName} for chatId ${cid}`);
  } catch (e) {
    if (e.name === 'ServiceNotFoundException' || e.name === 'ServiceNotActiveException') {
      await ecs.send(new CreateServiceCommand({
        cluster: ECS_CLUSTER,
        serviceName: svcName,
        taskDefinition: TASK_DEFINITION,
        desiredCount: 1,
        launchType: 'FARGATE',
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets: SUBNET_IDS,
            securityGroups: [TASK_SG_ID],
            assignPublicIp: 'ENABLED',
          },
        },
        tags: [{ key: 'claudecode:chatId', value: cid }],
      }));
      console.log(`Created service ${svcName} for chatId ${cid}`);
    } else {
      throw e;
    }
  }

  // Return empty taskArn — bridge self-registers in DynamoDB when it comes up.
  return { taskArn: '' };
}

/**
 * Returns the private IP of a running task for the given service, or null.
 * The bridge also self-registers its IP in DynamoDB, so this is only needed
 * as a fallback.
 */
async function getContainerIp(chatId) {
  const cid = String(chatId);
  const svcName = `user-${cid}`;
  try {
    const { taskArns } = await ecs.send(new ListTasksCommand({
      cluster: ECS_CLUSTER,
      serviceName: svcName,
      desiredStatus: 'RUNNING',
    }));
    if (!taskArns?.length) return null;
    const { tasks } = await ecs.send(new DescribeTasksCommand({
      cluster: ECS_CLUSTER,
      tasks: taskArns,
    }));
    const task = tasks?.[0];
    if (!task || task.lastStatus !== 'RUNNING') return null;
    const eni = task.attachments?.find((a) => a.type === 'ElasticNetworkInterface');
    return eni?.details?.find((d) => d.name === 'privateIPv4Address')?.value || null;
  } catch {
    return null;
  }
}

module.exports = { provisionUser, getContainerIp };

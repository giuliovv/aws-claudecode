#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { ClaudeCodeStack } from '../lib/claudecode-stack';

const app = new cdk.App();

new ClaudeCodeStack(app, 'ClaudeCodeStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
  },
  description: 'Claude Code / Codex multi-tenant Telegram service',
});

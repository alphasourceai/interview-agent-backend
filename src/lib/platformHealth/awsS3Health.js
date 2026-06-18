'use strict';

const { HeadBucketCommand, S3Client } = require('@aws-sdk/client-s3');
const {
  cachedLiveCall,
  costSummary,
  envConfigured,
  envValue,
  metric,
  readiness,
  safeErrorMessage,
  shouldRunLiveCheck,
  statusWithProblems,
  withTimeout,
} = require('./normalizePlatformHealth');

function bucketName(env) {
  return envValue(env, ['TAVUS_RECORDING_S3_BUCKET_NAME', 'AWS_S3_BUCKET', 'S3_BUCKET', 'S3_RECORDINGS_BUCKET']);
}

function regionName(env) {
  return envValue(env, ['AWS_REGION', 'TAVUS_RECORDING_S3_BUCKET_REGION']);
}

async function headBucket(context) {
  const client = new S3Client({ region: regionName(context.env) });
  await withTimeout(
    client.send(new HeadBucketCommand({ Bucket: bucketName(context.env) })),
    Number(context.timeoutMs || 4000)
  );
  return { reachable: true };
}

async function buildAwsS3Health(context) {
  const { env, now, signals } = context;
  const bucketConfigured = Boolean(bucketName(env));
  const regionConfigured = Boolean(regionName(env));
  const credentialConfigured = envConfigured(env, ['AWS_ACCESS_KEY_ID']) && envConfigured(env, ['AWS_SECRET_ACCESS_KEY']);
  const configured = bucketConfigured && regionConfigured;
  let live = null;
  let liveError = null;

  if (configured && shouldRunLiveCheck(context, 'AWS_S3_HEALTH_ENABLED')) {
    try {
      live = await cachedLiveCall(
        context,
        `aws-s3:${bucketName(env)}:${regionName(env)}`,
        () => headBucket(context)
      );
    } catch (error) {
      liveError = error;
    }
  }

  const liveConnected = Boolean(live?.reachable);
  const problem = signals.recordingDeleteErrors >= 5;
  const warning = Boolean(liveError || signals.recordingDeleteErrors || signals.recordingProblems || (configured && !liveConnected));

  return {
    key: 'aws_s3',
    name: 'AWS/S3',
    status: statusWithProblems({ configured, liveConnected, warning, problem }),
    configured,
    live_api_connected: liveConnected,
    connection_label: liveConnected ? 'Connected' : configured ? 'Live API not connected' : 'Configuration missing',
    source_label: liveConnected ? 'Live vendor API and estimated from recording records' : 'Estimated from recording records',
    source_code: liveConnected ? 'live_vendor_api' : 'estimated_from_records',
    meaning: 'Shows recording storage reachability and storage-related problems.',
    health_summary: liveConnected
      ? 'Recording storage bucket is reachable.'
      : configured
        ? 'Recording storage configuration exists; bucket reachability is not connected or did not complete.'
        : 'Recording storage bucket or region is not configured.',
    usage_summary: [
      metric('Bucket configured', bucketConfigured ? 'Yes' : 'No', 'Whether a recording bucket name is configured.'),
      metric('Region configured', regionConfigured ? 'Yes' : 'No', 'Whether an AWS region is configured.'),
      metric('Credentials configured', credentialConfigured ? 'Yes' : 'Default/IAM or not configured', 'Whether explicit AWS credentials are present.'),
      metric('Recording ready proxy', signals.recordingReady, 'Ready recordings from alphaScreen interview records.'),
    ],
    problem_summary: [
      metric('Recording pending/problem', signals.recordingPending + signals.recordingProblems, 'Recordings not ready or marked problem in alphaScreen records.'),
      metric('Storage/delete errors', signals.recordingDeleteErrors, 'Storage cleanup errors stored on interview rows.'),
      metric('Bucket reachability', liveConnected ? 'Reachable' : liveError ? 'Check failed' : 'Not connected', 'HeadBucket result when safe AWS access is available.'),
    ],
    cost_summary: costSummary({ help: 'S3 object count, size, and cost are not checked here to avoid expensive or broad bucket scans.' }),
    readiness_items: [
      readiness('Bucket', bucketConfigured ? 'Configured' : 'Missing', 'Required to store Tavus recordings.'),
      readiness('Region', regionConfigured ? 'Configured' : 'Missing', 'Required for S3 operations.'),
      readiness('Bucket reachability', liveConnected ? 'Connected' : 'Not connected', 'Uses a bounded HeadBucket check when configured.'),
    ],
    troubleshooting_note: liveError ? safeErrorMessage(liveError, 'S3 bucket check failed.') : null,
    last_checked: now.toISOString(),
    notes: liveError ? ['S3 bucket reachability could not be confirmed; recording records are still shown.'] : [],
  };
}

module.exports = { buildAwsS3Health };

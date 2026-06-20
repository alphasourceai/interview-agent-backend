'use strict';

const express = require('express');
const { supabaseAdmin } = require('../src/lib/supabaseClient');

const router = express.Router();
const EVENT_NAME_RE = /^[a-z][a-z0-9_]{1,80}$/;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 180;
const rateBuckets = new Map();

function rateLimit(req, res, next) {
  const now = Date.now();
  const ip = String((req.headers['x-forwarded-for'] || req.ip || 'unknown')).split(',')[0].trim() || 'unknown';
  const current = rateBuckets.get(ip);
  const bucket = (!current || current.resetAt <= now)
    ? { count: 0, resetAt: now + RATE_WINDOW_MS }
    : current;
  bucket.count += 1;
  rateBuckets.set(ip, bucket);
  if (bucket.count > RATE_MAX) {
    return res.status(429).json({
      error: 'rate_limited',
      code: 'RATE_LIMIT_EXCEEDED',
      request_id: req.request_id || null,
    });
  }
  return next();
}

function trimText(value, max = 300) {
  return String(value || '').trim().slice(0, max);
}

function cleanPath(value) {
  const raw = trimText(value, 500);
  if (!raw) return '';
  try {
    const url = new URL(raw, 'https://www.alphasourceai.com');
    return trimText(url.pathname || '/', 300);
  } catch (_) {
    return trimText(raw.split('?')[0].split('#')[0], 300);
  }
}

function normalizeJsonObject(value, maxString = 300) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    const safeKey = trimText(key, 80);
    if (!safeKey || raw === null || raw === undefined) continue;
    if (typeof raw === 'string') out[safeKey] = trimText(raw, maxString);
    else if (typeof raw === 'number' && Number.isFinite(raw)) out[safeKey] = raw;
    else if (typeof raw === 'boolean') out[safeKey] = raw;
    else if (Array.isArray(raw)) out[safeKey] = raw.slice(0, 20).map((item) => trimText(item, 120));
    else out[safeKey] = trimText(JSON.stringify(raw), maxString);
  }
  return out;
}

function normalizeOccurredAt(value) {
  const parsed = value ? new Date(value) : new Date();
  if (Number.isNaN(parsed.getTime())) return new Date().toISOString();
  return parsed.toISOString();
}

function toEventRows(req) {
  const rawEvents = Array.isArray(req.body?.events) ? req.body.events : [req.body];
  return rawEvents.slice(0, 10).flatMap((event) => {
    const eventName = trimText(event?.event_name, 100);
    if (!EVENT_NAME_RE.test(eventName)) return [];
    return [{
      event_name: eventName,
      anonymous_id: trimText(event?.anonymous_id, 120),
      session_id: trimText(event?.session_id, 120),
      path: cleanPath(event?.path) || '/',
      page_title: trimText(event?.page_title, 180),
      referrer_path: cleanPath(event?.referrer_path),
      utm: normalizeJsonObject(event?.utm, 160),
      properties: normalizeJsonObject(event?.properties, 300),
      occurred_at: normalizeOccurredAt(event?.occurred_at),
      request_id: req.request_id || null,
    }];
  });
}

router.post('/events', rateLimit, async (req, res) => {
  try {
    const rows = toEventRows(req);
    if (rows.length === 0) {
      return res.status(400).json({
        error: 'invalid_event',
        code: 'VALIDATION_ERROR',
        request_id: req.request_id || null,
      });
    }

    const { error } = await supabaseAdmin
      .from('public_analytics_events')
      .insert(rows);

    if (error) {
      console.error('[public-analytics/events] insert error:', error.message);
      return res.status(503).json({
        error: 'analytics_not_configured',
        code: 'ANALYTICS_TABLE_ERROR',
        detail: error.message,
        request_id: req.request_id || null,
      });
    }

    return res.status(202).json({
      ok: true,
      accepted: rows.length,
      request_id: req.request_id || null,
    });
  } catch (e) {
    console.error('[public-analytics/events] unexpected:', e?.message || e);
    return res.status(500).json({
      error: 'server_error',
      code: 'SERVER_ERROR',
      request_id: req.request_id || null,
    });
  }
});

module.exports = router;

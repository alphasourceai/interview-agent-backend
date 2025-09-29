// routes/recordingReady.js
const fetch = require('node-fetch');
const mime = require('mime-types');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');
const tmp = require('tmp');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const { OpenAI } = require('openai');
const { supabase } = require('../supabaseClient');
const { generateCandidatePDF } = require('../utils/pdfMonkey');

ffmpeg.setFfmpegPath(ffmpegStatic); // use static ffmpeg binary

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------- helpers ----------
async function downloadFile(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch file: ${response.statusText}`);
  const contentType = response.headers.get('content-type') || 'application/octet-stream';
  const ext = mime.extension(contentType) || 'mp4';
  const buffer = await response.buffer();
  return { buffer, ext, contentType };
}

function writeTmpFile(buffer, ext) {
  const { name: filePath } = tmp.fileSync({ postfix: '.' + ext });
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function secondsToMs(s) { return Math.round((Number(s) || 0) * 1000); }

// Sample frames ~ every 2s, capped by maxFrames, store as tiny JPGs for upload or analysis
async function sampleFrames(videoPath, outDir, everySeconds = 2, maxFrames = 40, width = 320) {
  ensureDir(outDir);
  const pattern = path.join(outDir, 'frame-%03d.jpg');
  // Extract at ~0.5 fps (1 frame every 2 seconds) and scale
  await new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .outputOptions([`-vf`, `fps=1/${everySeconds},scale=${width}:-1`])
      .output(pattern)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });

  // Collect up to maxFrames
  const files = fs.readdirSync(outDir)
    .filter(f => f.startsWith('frame-') && f.endsWith('.jpg'))
    .sort()
    .slice(0, maxFrames)
    .map(f => path.join(outDir, f));

  return files;
}

async function extractAudio(videoPath, outPath) {
  await new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .outputOptions(['-ar 16000', '-ac 1']) // 16k mono
      .save(outPath)
      .on('end', resolve)
      .on('error', reject);
  });
  return outPath;
}

// Upload a local file to Supabase storage and return a public URL
async function uploadToBucket(bucket, filePath, destPath, contentType) {
  const fileBuf = fs.readFileSync(filePath);
  const { error } = await supabase.storage.from(bucket).upload(destPath, fileBuf, {
    contentType: contentType || mime.lookup(path.extname(destPath)) || 'application/octet-stream',
    upsert: true
  });
  if (error) throw new Error(`Supabase upload to ${bucket} failed: ${error.message}`);
  const { data } = supabase.storage.from(bucket).getPublicUrl(destPath);
  return data.publicUrl;
}

// Very small prosody summary from transcript words/timestamps
function prosodyFromWhisper(whisperSegments) {
  // If we don’t have word timestamps, approximate with segment times.
  const words = [];
  let totalChars = 0;
  let startMs = null, endMs = null;
  for (const seg of whisperSegments || []) {
    if (startMs == null && seg?.start != null) startMs = secondsToMs(seg.start);
    if (seg?.end != null) endMs = secondsToMs(seg.end);
    const t = (seg?.text || '').trim();
    if (t) {
      const parts = t.split(/\s+/).filter(Boolean);
      words.push(...parts);
      totalChars += t.length;
    }
  }
  const durationMin = Math.max(0.001, ((endMs ?? 0) - (startMs ?? 0)) / 60000);
  const wpm = Math.round(words.length / durationMin);

  // Filler count
  const fillerList = ['um', 'uh', 'like', 'you know', 'sort of', 'kind of'];
  const fillerCount = words.reduce((acc, w) => {
    const lw = w.toLowerCase().replace(/[^a-z]/g, '');
    return acc + (fillerList.includes(lw) ? 1 : 0);
  }, 0);
  const fillerRate = Math.round((fillerCount / Math.max(1, words.length)) * 1000) / 10; // %

  // crude pauses: gaps between segment .start and previous .end > 1.2s
  let longPauses = 0;
  let longestPauseMs = 0;
  let prevEnd = null;
  for (const seg of whisperSegments || []) {
    if (prevEnd != null && seg?.start != null) {
      const gap = secondsToMs(seg.start) - secondsToMs(prevEnd);
      if (gap > 1200) {
        longPauses += 1;
        if (gap > longestPauseMs) longestPauseMs = gap;
      }
    }
    if (seg?.end != null) prevEnd = seg.end;
  }

  return {
    wpm,
    filler_rate_pct: fillerRate,
    long_pauses: longPauses,
    longest_pause_ms: longestPauseMs
  };
}

// Make a base64 for a small image (keeps payload small)
function fileToBase64(p) {
  const b = fs.readFileSync(p);
  return `data:image/jpeg;base64,${b.toString('base64')}`;
}

// NEW: write JSON to a tmp file (returns local path)
function writeTmpJson(obj) {
  const { name: p } = tmp.fileSync({ postfix: '.json' });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf-8');
  return p;
}

// NEW: find latest 'interviews' row id for a given candidate (candidates.id)
async function findLatestInterviewRowId(candidateRowId) {
  const { data, error } = await supabase
    .from('interviews')
    .select('id, created_at')
    .eq('candidate_id', candidateRowId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return null;
  return data?.id || null;
}

// ---------- OpenAI calls ----------
async function transcribeWithWhisper(audioPath) {
  const file = fs.createReadStream(audioPath);
  const resp = await openai.audio.transcriptions.create({
    file,
    model: 'whisper-1', // server-side transcription
    // timestamps are per segment, not per word for whisper-1 API; we will use segments
    response_format: 'verbose_json'
  });
  // resp.segments: [{ id, start, end, text }, ...]
  return resp;
}

// Multimodal scoring from frames + prosody + sample transcript
async function scoreInterview({ frames, prosody, transcriptSnippet }) {
  // Pick up to ~10 diverse frames
  const pick = frames.filter(Boolean).slice(0, 10).map(p => fileToBase64(p));

  const sys = `You are grading a video interview. 
Return strict JSON with integer scores 0-100 for clarity, confidence, body_language, total_score,
and a concise 2-3 sentence summary grounded in the visual cues and prosody (not just the words).
Consider posture, gaze, facial expressiveness for body_language; hesitation and fluency for clarity; 
composure and presence for confidence. Calibrate total_score as the overall impression.`;

  const userParts = [
    { type: 'text', text: `Prosody features: ${JSON.stringify(prosody)}` },
    { type: 'text', text: `Transcript snippet (for context, not content grading):\n${transcriptSnippet}` },
    ...pick.map(b64 => ({ type: 'image_url', image_url: { url: b64 } })),
    { type: 'text', text: `Return ONLY JSON like:
{"clarity":90,"confidence":86,"body_language":82,"total_score":86,"summary":"..."}
` }
  ];

  const resp = await openai.chat.completions.create({
    model: 'gpt-4o-mini', // cost-effective multimodal
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: userParts }
    ],
    temperature: 0.2
  });

  const raw = resp.choices?.[0]?.message?.content?.trim() || '{}';
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // try to salvage JSON (basic)
    const m = raw.match(/\{[\s\S]*\}/);
    parsed = m ? JSON.parse(m[0]) : {};
  }

  // sanitize
  const clamp = n => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
  const out = {
    clarity: clamp(parsed.clarity),
    confidence: clamp(parsed.confidence),
    body_language: clamp(parsed.body_language),
    total_score: clamp(parsed.total_score),
    summary: String(parsed.summary || '').slice(0, 600)
  };
  // if total_score missing, average
  if (!out.total_score) {
    const parts = [out.clarity, out.confidence, out.body_language].filter(n => n > 0);
    out.total_score = parts.length ? Math.round(parts.reduce((a, b) => a + b, 0) / parts.length) : 0;
  }
  return out;
}

// ---------- main handler ----------
const handleWebhook = async (req, res) => {
  const payload = req.body;

  let transcriptTmpPath = null;
  let analysisTmpPath = null;

  try {
    await supabase.from('webhook_logs').insert({ event_type: 'recording-ready', payload });

    const {
      candidate_id,
      conversation_id,
      video_url,
      duration_seconds,
      completed_at
    } = payload;

    if (!video_url || !candidate_id || !conversation_id) {
      return res.status(400).json({ error: 'Missing required fields in webhook payload.' });
    }

    // 1) Download video and upload to Supabase
    const { buffer, ext, contentType } = await downloadFile(video_url);
    const tmpVideo = writeTmpFile(buffer, ext);

    const videoKey = `interviews/${candidate_id}_${conversation_id}.${ext}`;
    const publicVideoUrl = await uploadToBucket('videos', tmpVideo, videoKey, contentType);

    // Update conversations
    const { error: updateConvError } = await supabase
      .from('conversations')
      .update({
        status: 'ready',
        interview_video_url: publicVideoUrl,
        duration_seconds,
        completed_at
      })
      .eq('conversation_id', conversation_id);

    if (updateConvError) throw new Error(`Supabase update failed: ${updateConvError.message}`);

    // 2) Extract audio + frames to temp
    const workDir = tmp.dirSync({ unsafeCleanup: true }).name;
    const framesDir = path.join(workDir, 'frames');
    ensureDir(framesDir);

    const audioPath = path.join(workDir, 'audio.wav');
    await extractAudio(tmpVideo, audioPath);
    const frameFiles = await sampleFrames(tmpVideo, framesDir, 2, 40, 320);

    // 3) Transcribe with Whisper
    const whisper = await transcribeWithWhisper(audioPath);
    const segments = whisper?.segments || [];
    const fullTranscript = (whisper?.text || '').trim();
    const transcriptSnippet = fullTranscript.slice(0, 1800); // keep prompt compact

    // 4) Prosody features
    const prosody = prosodyFromWhisper(segments);

    // 5) Multimodal interview scoring
    const interviewOut = await scoreInterview({
      frames: frameFiles,
      prosody,
      transcriptSnippet
    });

    // 6) Persist to reports (and keep interview_video_url there too)
    const { data: candidate, error: candidateError } = await supabase
      .from('candidates')
      .select('id, name, email')
      .eq('candidate_id', candidate_id)
      .single();

    if (candidateError || !candidate) {
      return res.status(404).json({ error: 'Candidate not found', details: candidateError });
    }

    // --- Upload transcript & analysis artifacts and update interviews row (NEW) ---
    // Build transcript payload (keep segments for debugging/prosody)
    const transcriptPayload = {
      conversation_id,
      candidate_id,
      text: fullTranscript,
      segments
    };
    transcriptTmpPath = writeTmpJson(transcriptPayload);
    const transcriptKey = `interviews/${candidate_id}/${conversation_id}.json`;
    const transcriptUrl = await uploadToBucket('transcripts', transcriptTmpPath, transcriptKey, 'application/json');

    // Build analysis payload (scores + prosody)
    const analysisPayload = {
      conversation_id,
      candidate_id,
      analysis: {
        clarity: interviewOut.clarity,
        confidence: interviewOut.confidence,
        body_language: interviewOut.body_language,
        total_score: interviewOut.total_score,
        summary: interviewOut.summary
      },
      prosody
    };
    analysisTmpPath = writeTmpJson(analysisPayload);
    const analysisKey = `interviews/${candidate_id}/${conversation_id}.json`;
    const analysisUrl = await uploadToBucket('analysis', analysisTmpPath, analysisKey, 'application/json');

    // Link these URLs to the most recent 'interviews' row for this candidate (best-effort)
    const interviewRowId = await findLatestInterviewRowId(candidate.id);
    if (interviewRowId) {
      await supabase
        .from('interviews')
        .update({
          status: 'Complete',
          transcript_url: transcriptUrl,
          analysis_url: analysisUrl,
          // Store raw transcript text for convenient querying/filters
          transcript: fullTranscript || null
        })
        .eq('id', interviewRowId);
    }
    // --- end NEW ---

    // Ensure a report row exists for this candidate (upsert)
    const { data: existingReport } = await supabase
      .from('reports')
      .select('*')
      .eq('candidate_id', candidate.id)
      .maybeSingle();

    const reportPatch = {
      interview_breakdown: {
        clarity: interviewOut.clarity,
        confidence: interviewOut.confidence,
        body_language: interviewOut.body_language,
        total_score: interviewOut.total_score,
        prosody, // keep raw features for debugging/analytics
      },
      interview_summary: interviewOut.summary,
      interview_video_url: publicVideoUrl
    };

    if (existingReport) {
      const { error: upErr } = await supabase
        .from('reports')
        .update(reportPatch)
        .eq('candidate_id', candidate.id);
      if (upErr) throw upErr;
    } else {
      const { error: insErr } = await supabase
        .from('reports')
        .insert([{ candidate_id: candidate.id, ...reportPatch }]);
      if (insErr) throw insErr;
    }

    // NOTE: PDF generation is now on-demand from the Client Dashboard.
    // This webhook will only auto-generate when GENERATE_PDF_AUTOMATIC='true'.
    if (process.env.GENERATE_PDF_AUTOMATIC === 'true') {
      // 7) If resume + interview ready, (still) generate PDF
      const { data: reportReload, error: repErr } = await supabase
        .from('reports')
        .select('*')
        .eq('candidate_id', candidate.id)
        .single();
      if (repErr) throw repErr;

      const resumeReady = !!(reportReload?.resume_breakdown?.total_score);
      const interviewReady = !!(reportReload?.interview_breakdown?.total_score);

      if (resumeReady && interviewReady) {
        const payloadForPDF = {
          name: candidate.name,
          email: candidate.email,
          resume: reportReload.resume_breakdown,
          interview: reportReload.interview_breakdown,
          overall_score: Math.round(
            (Number(reportReload.resume_breakdown.total_score || 0) +
              Number(reportReload.interview_breakdown.total_score || 0)) / 2
          ),
          status: 'Report Ready',
          summary: reportReload.interview_summary || ''
        };

        const report_url = await generateCandidatePDF(payloadForPDF);

        await supabase
          .from('reports')
          .update({ report_url })
          .eq('candidate_id', candidate.id);
      }
    }

    // Best-effort cleanup of tmp files
    try { fs.unlinkSync(tmpVideo); } catch {}
    try { fs.unlinkSync(audioPath); } catch {}
    try {
      for (const f of frameFiles) fs.unlinkSync(f);
    } catch {}
    try { if (transcriptTmpPath) fs.unlinkSync(transcriptTmpPath); } catch {}
    try { if (analysisTmpPath) fs.unlinkSync(analysisTmpPath); } catch {}

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Webhook Error:', err);
    return res.status(500).json({ error: err.message });
  }
};

module.exports = { handleWebhook };
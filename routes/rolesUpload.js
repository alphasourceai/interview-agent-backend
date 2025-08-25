const express = require("express");
const multer = require("multer");
const path = require("path");
const { randomUUID } = require("crypto");
const { supabaseAdmin } = require("../src/lib/supabaseClient");
const { BUCKETS } = require("../config/storage");

const router = express.Router();

// ✅ make storage explicit so req.file.buffer is always available
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
});

// helper: simple filename sanitizer
function sanitize(name) {
  return String(name || "file").replace(/[^\w.\-]+/g, "_");
}

// POST /roles/upload-jd?client_id=...
// form-data: file=<pdf|doc|docx>
router.post("/upload-jd", upload.single("file"), async (req, res) => {
  try {
    const clientId = req.query.client_id;

    // ✅ client scope check (your app sets req.clientIds in app.js)
    if (!clientId || !Array.isArray(req.clientIds) || !req.clientIds.includes(clientId)) {
      return res.status(403).json({ error: "No client scope" });
    }

    if (!req.file) {
      return res.status(400).json({ error: "file required" });
    }

    // (optional) basic mime/type guard
    const okTypes = new Set([
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ]);
    if (!okTypes.has(req.file.mimetype)) {
      // allow anyway if extension looks OK; otherwise reject
      const ext = path.extname(req.file.originalname || "").toLowerCase();
      const okExt = new Set([".pdf", ".doc", ".docx"]);
      if (!okExt.has(ext)) {
        return res.status(400).json({ error: "Unsupported file type" });
      }
    }

    const bucket = BUCKETS?.KBS || "kbs"; // your config should define this bucket
    const ext = path.extname(req.file.originalname || "").toLowerCase();
    const base = sanitize(path.basename(req.file.originalname || "jd" + (ext || "")));
    const key = `jd/${clientId}/${Date.now()}_${randomUUID()}_${base}`;

    // ✅ upload buffer to Supabase Storage (private bucket)
    const { error } = await supabaseAdmin.storage
      .from(bucket)
      .upload(key, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: true,
      });

    if (error) {
      console.error("upload-jd storage error:", error.message);
      return res.status(500).json({ error: "Upload failed" });
    }

    // return a reference your roles create will persist
    return res.json({
      bucket,
      path: key,
      original_name: req.file.originalname,
      mime_type: req.file.mimetype,
      size: req.file.size,
    });
  } catch (e) {
    console.error("upload-jd error", e);
    return res.status(500).json({ error: "Upload failed" });
  }
});

module.exports = router;

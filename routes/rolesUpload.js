const express = require("express");
const multer = require("multer");
const path = require("path");
const { randomUUID } = require("crypto");
const { supabaseAdmin } = require("../src/lib/supabaseClient");
const { BUCKETS } = require("../config/storage");

const router = express.Router();
const upload = multer({ limits: { fileSize: 20 * 1024 * 1024 } }); // 20MB

// POST /roles/upload-jd?client_id=...
// form-data: file=<pdf|doc|docx>
router.post("/upload-jd", upload.single("file"), async (req, res) => {
  try {
    const clientId = req.query.client_id;
    if (!clientId || !req.clientIds || !req.clientIds.includes(clientId)) {
      return res.status(403).json({ error: "Forbidden or missing client_id" });
    }
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const allowed = [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ];
    if (!allowed.includes(req.file.mimetype)) {
      return res.status(400).json({ error: "Unsupported file type" });
    }

    const ext = path.extname(req.file.originalname).toLowerCase();
    const key = `role-jds/${clientId}/${randomUUID()}${ext}`;

    const { error: upErr } = await supabaseAdmin.storage
      .from(BUCKETS.KBS)
      .upload(key, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false,
      });

    if (upErr) return res.status(500).json({ error: upErr.message });

    return res.json({
      bucket: BUCKETS.KBS,
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

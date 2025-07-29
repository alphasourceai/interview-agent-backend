const handleWebhook = async (req, res) => {
  try {
    const payload = req.body;
    console.log('Webhook received:', payload);

    // TODO: Trigger video download + AI analysis here

    return res.status(200).json({ message: 'Webhook received' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Webhook handler error', details: err.message });
  }
};

module.exports = { handleWebhook };

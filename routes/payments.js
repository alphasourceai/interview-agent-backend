'use strict';

const express = require('express');
const { createPaymentIntent } = require('../handlers/createPaymentIntent');

const router = express.Router();

router.post('/create-intent', createPaymentIntent);

module.exports = router;

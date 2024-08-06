const express = require('express');
const router = express.Router();

const apolloServer = require('../services/apollo');

const { conversationDataSource } = require('../models/Conversation');

router.use((req, res, next) => {
  next();
});

// define the home page route
router.post('/stripe', async(request, response) => {
  const stripeSignature = request.headers['stripe-signature'];

  const ret = await apolloServer.requestOptions
    .dataSources()
    .orders.updateStatusFromWebhook(stripeSignature, request.body);

  if ( !ret ) {
    response.status(500).json({success:false});
    return;
  }
  response.status(200).json({success:true});
});

router.post('/twilio', async (req, res) => {
  try {
    await conversationDataSource.conversations.twilioWebhook(req.body);
    res.status(200);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: e.message });
  }
});

module.exports = router;

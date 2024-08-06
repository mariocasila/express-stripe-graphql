const isEmpty = require('lodash/isEmpty');
const { firebase } = require('../services/firebase');
const { UserModel, UserRole } = require('../models/User');

const OperationsWithoutAuth = [
  '{splits(',
  '{split(',
  '{categories(',
  '{categories{',
  '{createUser(',
  '{fee(',
];

const originalUrls = [
  {
    url: '/webhooks/twilio',
    userAgent: 'TwilioProxy/1.1',
  },

  {
    url: '/webhooks/stripe',
  },
];

async function authMiddleware(req, res, next) {
  const headerToken = req.headers.authorization;
  const apiKey = req.query.apiKey || req.headers.apiKey;

  const q = req.body.query || '';

  const isOperatorWithNoToken = OperationsWithoutAuth.some((element) => {
    return q.replace(/\s/g, '').includes(element);
  });

  if (
    process.env.NODE_ENV !== 'production' ||
    (apiKey && apiKey === process.env.API_KEY)
  ) {
    const { impersonate } = req.headers;

    req.user = await UserModel.findOne(
      impersonate ? { _id: impersonate } : { email: 'yurii@synapps.agency' },
      '_id role firebaseId subscriptionCode fcmTokens phoneNumber stripeCustomerId'
    )
      .lean()
      .exec();
    next();
    return;
  }

  if (!headerToken) {
    if (isOperatorWithNoToken) {
      req.unauthenticated = true;

      req.user = {
        _id: 'dummy',
        role: UserRole.USER,
        subscriptionCode: null,
        fcmTokens: null,
        phoneNumber: null,
        stripeCustomerId: null,
      };

      next();
      return;
    }

    if (
      originalUrls.find(
        (entry) =>
          entry.url === req.originalUrl &&
          entry.userAgent === req.headers['user-agent']
      )
    ) {
      req.unauthenticated = true;
      req.user = null;
      next();
      return;
    }

    return res.send({ message: 'No token provided' }).status(401);
  }

  if (headerToken && headerToken.split(' ')[0] !== 'Bearer') {
    res.send({ message: 'Invalid token' }).status(401);
  }

  const token = headerToken.split(' ')[1];

  try {
    const auth = await firebase.auth().verifyIdToken(token);
    req.user = await UserModel.findOne(
      { firebaseId: auth.user_id },
      '_id role firebaseId subscriptionCode fcmTokens phoneNumber stripeCustomerId'
    )
      .lean()
      .exec();

    if (isEmpty(req.user) && req.body.operationName !== 'createUser') {
      res.send({ message: "User doesn't exist" }).status(401);
    }

    next();
  } catch (e) {
    console.log(e);
    res.send({ message: 'Could not authorize' }).status(403);
  }
}

module.exports = authMiddleware;

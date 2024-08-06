if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}
const fs = require('fs');

const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
// const useragent = require('express-useragent');
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const compression = require('compression');

const firebaseAuth = require('./middleware/firebase-auth');
const scheduler = require('./services/scheduler');

const app = express();
const webhookService = require('./services/webhook');
const port = process.env.API_PORT || 3001;

const whitelist = [
  'http://wannasplit.local:3000',
  'https://wannasplit.local:3000',
  'https://wannasplit.local:3001',
  'https://wannasplit.local:3003',
  'https://stage-api.wannasplit.app',
  'https://api.wannasplit.app',
  'https://stage-admin.wannasplit.app',
  'https://admin.wannasplit.app',
  'https://studio.apollographql.com',
];

mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  poolSize: 20,
});
mongoose.set('debug', process.env.NODE_ENV === 'development');

app.use(morgan('combined'));
app.use('/webhooks/stripe', bodyParser.raw({ type: '*/*' }));
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
// app.use(useragent.express());
app.use(cookieParser());
app.use(compression());
app.use(
  cors({
    credentials: true,
    origin: function (origin, callback) {
      if (typeof origin === 'undefined' || whitelist.indexOf(origin) !== -1) {
        // console.log( `CORS Allowed for ${ origin }`);
        callback(null, true);
      } else {
        callback(new Error(`Not allowed by CORS: ${origin}`));
      }
    },
  })
);

app.use(firebaseAuth);

scheduler.init();

const { apolloServer, schedulerTasks } = require('./services/apollo');

schedulerTasks.forEach(t=>t());

async function start() {
  await apolloServer.start();
  apolloServer.applyMiddleware({ app });
  app.use('/webhooks', webhookService);

  if (process.env.NODE_ENV !== 'production') {
    const https = require('https');
    const key = fs.readFileSync('./cert/wannasplit.local-key.pem');
    const cert = fs.readFileSync('./cert/wannasplit.local.pem');

    https
      .createServer({ key, cert }, app)
      .listen(port)
      .on('listening', () => {
        console.log(
          `🚀 Server ready at https://wannasplit.local:${port}${apolloServer.graphqlPath}`
        );
      });
  } else {
    app.listen(port).on('listening', () => {
      console.log(`[ API ] Docker process up. Port : ${port}`);
    });
  }
}

start();

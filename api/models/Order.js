const mongoose = require('mongoose');
const DataLoader = require('dataloader');

const { BaseDataSource } = require('./BaseDataSource');
const { StripeService } = require('../services/stripe');
const { TwilioService } = require('../services/twilio');
const { StripePaymentStatusType } = require('../services/stripe');
const { SYSTEM_FEE } = require('../config');
const { withCache } = require('../services/cache');
const { UserRole } = require('./User');

const OrderStatusType = {
  PAYMENT_PENDING: 'payment_pending',
  PAYMENT_FAILED: 'payment_failed',
  PAID: 'paid',
  SYSTEM_CANCELED: 'system_canceled',
  OWNER_CANCELED: 'owner_canceled',
  CLIENT_CANCELED: 'client_canceled',
  REFUND_REQUESTED: 'refund_requested',
  COMPLETE: 'complete',
  REFUNDED: 'refunded',
  SHIPPED: 'shipped',
  RECEIVED: 'received',
};

const exitableStatuses = [StripePaymentStatusType.CANCELED];

const promotableStatuses = [StripePaymentStatusType.SUCCESS];

const demotableStatuses = [StripePaymentStatusType.PAYMENT_FAILED];

const eventStatusMap = {
  [StripePaymentStatusType.CANCELED]: OrderStatusType.SYSTEM_CANCELED,
  [StripePaymentStatusType.FAILED]: OrderStatusType.PAYMENT_FAILED,
  [StripePaymentStatusType.SUCCESS]: OrderStatusType.PAID,
};

const orderTypes = /*gql*/ `

  enum OrderStatusType {
    ${Object.keys(OrderStatusType).join('\n')}
  }

  """
  This object type is about metadata that doesn't change and can be cached
  to avoid getting into multiple nested resolvers to get, speeds up things
  """
  type OrderMetaData {
    "the user who got into the split"
    clientName: String
    "the user who created the split"
    ownerName: String
    "split title"
    splitTitle: String
    splitDescription: String
    splitPicture: String
    amount: Float
    feeAmount: Float
  }

  type PaymentSheet {
    client_secret: String
    ephemeralKey: String
    stripe_publickey: String
  }

  type OrderPaymentIntentResponse {
    "Payment intent ID"
    paymentIntentId: String
    amount: Int
    feeAmount: Int
    paymentSheet: PaymentSheet
  }

  type Order {
    _id: ObjectID
    "The client that ordered the Split"
    client: User!
    owner: User!
    split: Split
    status: OrderStatusType
    "Number of seats in the Order"
    numSeats: Int
    "ID of a user's selected shipping address. We can get that easily because we have \`client\` already"
    shippingAddress: ShippingAddress
    "A bunch of aggregated props that will probably be requested a lot and are unlikely to change"
    metadata: OrderMetaData
    "Stripe technical info. If possible, avoid requesting this for performance reasons :) If anything is needeed frequently, let's add it to metadata"
    paymentMethod: StripePaymentMethod
    refunded: Boolean
    created_at: DateTime
    updated_at: DateTime
  }

  input OrderQuery {
    _id: ObjectID
    split: ObjectID
    owner: ObjectID
    numSeats: Int
    created_at: DateTimeQuery
    updated_at: DateTimeQuery
  }

  input GetOrderPaymentIntentInput {
    split: ObjectID!
    numSeats: Int!
  }

  input CreateOrderInput {
    split: ObjectID!
    numSeats: Int!
    shippingAddress: ObjectID!
    paymentIntent: String!
  }

  input UpdateOrderInput {
    shippingAddress: ObjectID
  }

  type CreateOrderResponse implements MutationResponse {
    code: String!
    success: Boolean!
    message: String
    order: Order
    conversation: Conversation
    "Will be returned in error state. Refunded automatically if successful"
    paymentIntent: String
  }

  extend type Query {
    "Get payment intent information necessary to perform a Stripe payment for the order configuration"
    getOrderPaymentIntent(order: GetOrderPaymentIntentInput!): OrderPaymentIntentResponse
    order(_id:ObjectID!):Order
    orders(query: OrderQuery,limit: Int, skip: Int, sort: SplitSort): [Order]
    myOrders:[Order]
  }

  extend type Mutation {
    createOrder( order: CreateOrderInput! ): CreateOrderResponse

    "Only allowed to change \`shippingAddress\` now. I don't see what else might need to be changed ever"
    updateOrder( _id: ObjectID!, order: UpdateOrderInput!): CreateOrderResponse

    """
      Admin only.
      Not sure we need to ever actually delete Orders if they're not buggy.
      Use \`cancelOrderOwner\` or \`cancelOrderClient\` instead
    """
    deleteOrder(_id: ObjectID!): CreateOrderResponse

    "As an Owner, cancel the order and remove user from the Split Room"
    cancelOrderOwner(split: ObjectID!, client: ObjectID!): CreateOrderResponse
    "As a Client, cancel the order and exit the Split Room"
    cancelOrderClient(split: ObjectID!): CreateOrderResponse

    "As an owner, mark order as shipped"
    markOrderShipped(_id: ObjectID!): CreateOrderResponse
    "As a client, mark order as received"
    markOrderReceived(_id: ObjectID!): CreateOrderResponse
  }
`;

const OrderMetadataSchema = mongoose.Schema({
  clientName: String,
  ownerName: String,
  splitTitle: String,
  splitDescription: String,
  splitPicture: String,
  amount: Number,
  feeAmount: Number,
});

const OrderSchema = mongoose.Schema(
  {
    client: {
      type: mongoose.Types.ObjectId,
      ref: 'User',
      index: true,
    },
    owner: {
      type: mongoose.Types.ObjectId,
      ref: 'User',
      index: true,
    },
    split: {
      type: mongoose.Types.ObjectId,
      ref: 'Split',
      index: true,
    },
    status: {
      type: String,
      required: true,
      index: true,
      enum: Object.values(OrderStatusType),
    },
    numSeats: {
      type: Number,
      required: true,
    },
    shippingAddress: {
      type: mongoose.Types.ObjectId,
      required: true,
      index: true,
    },
    paymentIntent: {
      type: String,
      required: true,
      index: true,
    },
    paymentMethod: {
      type: String,
      required: true,
      index: true,
    },
    metadata: OrderMetadataSchema,
    refunded: Boolean,
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    toJSON: { virtuals: true },
  }
);

const OrderModel = mongoose.model('Order', OrderSchema);

class OrderDataSource extends BaseDataSource {
  initialize(config) {
    this.stripeService = new StripeService();
    this.twilioService = new TwilioService();

    this.bExists = new DataLoader((queries) => this.batchExists(queries), {
      cache: false,
    });

    super.initialize(config);
  }

  async myOrders() {
    return await this.context.dataSources.orders.list({
      query: {
        client: this.context.user._id,
      },
    });
  }

  async getOrder({ _id }) {
    return await this.model.findOne({
      _id: _id,
      client: this.context.user._id,
    });
  }

  async list({ query, limit, skip, sort }, fields) {
    if (this.context.user.role !== UserRole.ADMIN) {
      query = {
        ...query,
        client: this.context.user._id,
      };
    }

    return await super.list({ query, limit, skip, sort }, fields);
  }

  aggregate(queries) {
    return this.model.aggregate([
      { $match: { $or: queries } },
      {
        $group: {
          _id: {
            client: '$client',
            owner: '$owner',
            split: '$split',
          },
          count: { $sum: 1 },
        },
      },
      {
        $project: {
          client: '$_id.client',
          owner: '$_id.owner',
          split: '$_id.split',
          count: '$count',
        },
      },
    ]);
  }

  async create({ order }) {
    const session = await mongoose.connection.startSession();

    let paymentIntent;

    try {
      //  Should not be able to use the same paymentIntent to create an order twice
      //  Should not be able to create multiple orders with the same client
      const existingOrder = await this.model.findOne({
        $or: [
          { paymentIntent: order.paymentIntent },
          {
            split: order.split,
            client: this.context.user._id,
            status: {
              $nin: [
                OrderStatusType.SYSTEM_CANCELED,
                OrderStatusType.OWNER_CANCELED,
                OrderStatusType.CLIENT_CANCELED,
              ],
            },
          },
        ],
      });

      if (existingOrder) {
        throw new Error(
          'This User already ordered this Split or paymentIntent already used'
        );
      }

      paymentIntent = await this.stripeService.getPaymentIntent(
        order.paymentIntent
      );

      if (!paymentIntent) {
        throw new Error("Can't find a paymentIntent with specified ID");
      }

      const split = await this.context.dataSources.splits.get(order.split);

      if (!split) {
        throw new Error("Can't find a Split with specified ID");
      }

      if (split.placesLeft < order.numSeats) {
        throw new Error("Can't order this many seats");
      }

      const [client, owner] = await Promise.all([
        this.context.dataSources.users.get(this.context.user._id),
        this.context.dataSources.users.get(split.user),
      ]);

      if (!client) {
        throw new Error(
          'How is it even possible to Order without authentication?'
        );
      }

      if (!owner) {
        throw new Error(
          'Split owner not found, the Split must be invalid or a test one'
        );
      }

      const { amount, feeAmount } = this.calcAmount(split, order.numSeats);

      order.owner = owner._id;
      order.client = client._id;
      order.paymentMethod = paymentIntent.payment_method || 'pending';

      if (Object.keys(eventStatusMap).includes(paymentIntent.status)) {
        order.status = eventStatusMap[paymentIntent.status];
      } else {
        order.status = OrderStatusType.PAYMENT_PENDING;
      }

      order.metadata = {
        clientName: client.fullname,
        ownerName: owner.fullname,
        splitTitle: split.title,
        splitDescription: split.description,
        splitPicture:
          split.media && split.media.length ? split.media[0].src : null,
        amount,
        feeAmount,
      };

      let newOrder;

      const { splits, conversations } = this.context.dataSources;

      await session.withTransaction(async () => {
        //  Create the order
        newOrder = await this.model.create([order], { session });
        //  Yurii: I want TypeScript here :'c
        let role = 'readonly';
        //  Join the Split if Order is already paid
        if (promotableStatuses.includes(paymentIntent.status)) {
          role = 'full';
        }

        await splits.join({
          split: order.split,
          order,
          client,
          session,
          role,
        });
      });

      const conversation = conversations.model.findOne({ split: order.split });

      return {
        code: 200,
        success: true,
        order: newOrder[0],
        conversation: conversation,
      };
    } catch (e) {
      //  Error happened so we should immediately refund the paymentIntent
      //  together with the fee
      if (paymentIntent.status === StripePaymentStatusType.SUCCESS) {
        await this.stripeService.refund(paymentIntent.id, true);
      } else {
        await this.stripeService.cancelPaymentIntent(paymentIntent.id);
      }

      return {
        code: 501,
        success: false,
        message: e.message,
        paymentIntent: paymentIntent.client_secret,
      };
    } finally {
      session.endSession();
    }
  }

  async getPaymentIntent({ order: { split, numSeats } }) {
    try {
      if (!numSeats || numSeats <= 0) {
        throw new Error(
          'Invalid input for `numSeats`, must be a positive non-zero number'
        );
      }

      const splitData = await this.context.dataSources.splits.get(split);

      if (!splitData) {
        throw new Error('Split not found');
      }

      //  Before we proceed any further, we need to check if this thing even has
      //  seats left
      if (splitData.placesLeft < numSeats) {
        throw new Error("Can't order this many seats");
      }

      const splitOwner = await this.context.dataSources.users.model.findOne(
        { _id: splitData.user },
        'stripeAccountId stripeChargesEnabled'
      );

      if (!splitOwner.stripeAccountId) {
        throw new Error('Stripe account is not set up or charges are disabled');
      }

      const { amount, feeAmount } = this.calcAmount(splitData, numSeats);

      const paymentIntentData = {
        customer: this.context.user.stripeCustomerId,
        destination: splitOwner.stripeAccountId,
        amount, // stripe accepts minimal unit of currency, for USD, need to sent cents of amount
        feeAmount,
      };

      const paymentIntent = await this.stripeService.createPaymentIntent(
        paymentIntentData
      );
      const ephemeralKey = await this.stripeService.createEphemeralKey(
        this.context.user.stripeCustomerId
      );

      return {
        paymentIntentId: paymentIntent.id,
        amount,
        feeAmount,
        paymentSheet: {
          ephemeralKey: ephemeralKey.secret,
          stripe_publickey: process.env.STRIPE_KEY,
          client_secret: paymentIntent.client_secret,
        },
      };
    } catch (e) {
      throw new Error(e.message);
    }
  }

  /**
   *  Calculate amounts necessary for `paymentIntent` to be created
   * */
  calcAmount(split, numSeats) {
    const perSplitPrice = split.price / split.numPlaces;
    const amount = parseFloat((perSplitPrice * numSeats).toFixed(2));
    const feeAmount = parseFloat((amount * SYSTEM_FEE).toFixed(2));

    return {
      amount: parseInt((amount + feeAmount) * 100),
      feeAmount: parseInt(feeAmount * 100),
    };
  }

  /**
   *  This is a webhook for Stripe PaymentIntent changing it's status
   * */
  async updateOrderStatusByWebhook(event) {
    const data = event.data.object;

    const order = await this.model.findOne({
      paymentIntent: data.id,
    });

    if (!order) {
      throw new Error('No order exists for the paymentIntent provided');
    }

    await this.updateOrderStatus(data, order);
  }

  /**
   *  This function is of limited use for stripe PaymentIntent updating it's status
   *  but can be used for general updating Order Status, I guess
   * */
  async updateOrderStatus(event, order) {
    const { splits } = this.context.dataSources;
    const session = await mongoose.connection.startSession();

    try {
      //  UPD 08.10.2022
      //    At this point, user should be in conversation already
      //    and his seats should be reserved
      await session.withTransaction(async () => {
        if (Object.keys(eventStatusMap).includes(event.status)) {
          order.status = eventStatusMap[event.status];
        }

        //  Exitable statuses, where User should be ejected out
        //  of the Split entirely
        if (exitableStatuses.includes(event.status)) {
          await splits.exit({
            split: order.split,
            client: order.client,
            order,
            message: `${order.metadata.clientName}'s order was cancelled`,
            session,
          });
        }
        //  Promotable statuses, on which User should be
        //  promoted from readonly to full member
        if (promotableStatuses.includes(event.status)) {
          await splits.updateParticipantRole({
            split: order.split,
            user: order.client,
            role: 'full',
            session,
          });
        }
        //  Demotable statuses, on which User should be
        //  demoted from full member to readonly
        if (demotableStatuses.includes(event.status)) {
          await splits.updateParticipantRole({
            split: order.split,
            user: order.client,
            role: 'readonly',
            session,
          });
        }

        await order.save({ session });
      });
      session.endSession();
    } catch (e) {
      session.endSession();
      throw new Error(e.message);
    }
    return order;
  }

  async hasReserved(userId, splitId) {
    return await this.model.findOne({
      client: userId,
      split: splitId,
      status: OrderStatusType.PAID,
    });
  }

  async updateStatusFromWebhook(signature, body) {
    try {
      const stripeService = new StripeService();
      const event = await stripeService.verifyWebhook(body, signature);
      switch (event.type) {
      case 'payment_intent.succeeded':
      case 'payment_intent.payment_failed':
      case 'payment_intent.canceled':
      case 'payment_intent.processing':
        await this.updateOrderStatusByWebhook(event);
        break;
      case 'charge.refunded':
        break;
      case 'payout.created':
        break;
      case 'payout.paid':
        break;
      default:
        break;
      }
    } catch (e) {
      return false;
    }
  }

  /**
   *  This function just bulk cancels and refunds all Orders of a Split
   *
   *  It is not intended for this function to do anything else in the future,
   *  so please don't add functionality to it.
   *
   *  This is done because bulk operations like this should not spam notifications
   *  and should just do the job.
   *
   *  e.g. canceling 10 Orders via OrderDataSource.cancelOwner will post
   *  10 messages to the Split Room of Owner cancelling the Orders while
   *  this is not our intention.
   *
   *  We should not also make `cancelOwner` or `cancelClient` less specific,
   *  more general, accept more arguments/modifiers, because they would do the job
   *  worse that a dedicated optimized function.
   *
   *  It's used in conjunction with:
   *    - SplitDataSource.cancel
   *    - SplitDataSource.expire
   * */
  async bulkCancel(
    { split, status = OrderStatusType.SYSTEM_CANCELED },
    extSession
  ) {
    if (!extSession) {
      throw new Error('session is required to do bulkCancel');
    }

    // get all orders data so we can refund them
    const ordersData = await this.batch.load({ split });
    // do the actual refund in bulk with Promise.all
    await Promise.all(
      ordersData.map(async (order) => {
        try {
          return await this.stripeService.refund(order.paymentIntent, true);
        } catch (e) {
          //  Nevermind already reversed transfers
          if (!e.message.includes('already fully reversed')) {
            throw e;
          }
        }
      })
    );
    // updateMany, no need to waste time updating individually
    await this.model.updateMany({ split }, { status });
  }

  async cancelOwner({ split, client }) {
    const session = await mongoose.connection.startSession();

    try {
      const { user } = this.context;
      const order = await this.model.findOne({
        split,
        client,
        status: {
          $nin: [
            OrderStatusType.CLIENT_CANCELED,
            OrderStatusType.OWNER_CANCELED,
            OrderStatusType.SYSTEM_CANCELED,
          ],
        },
      });

      if (!order) {
        throw new Error("Can't find Order with provided id");
      }

      if (order.owner.toString() !== user._id.toString()) {
        throw new Error('Only the Split Owner can cancel Order as Owner');
      }

      if (order.status !== OrderStatusType.PAID) {
        throw new Error("Can't cancel Order at this stage");
      }

      let refund;

      await session.withTransaction(async () => {
        const { splits } = this.context.dataSources;

        await splits.exit({
          split,
          order,
          session,
          client,
          message: `${order.metadata.ownerName} has cancelled ${order.metadata.clientName}'s order`,
        });

        //  Owner cancels, refund application fee
        refund = await this.stripeService.refund(order.paymentIntent, true);

        order.status = OrderStatusType.OWNER_CANCELED;
        await order.save({ session });
      });

      return {
        code: 200,
        success: true,
        order,
        refund,
      };
    } catch (e) {
      return {
        code: 501,
        success: false,
        message: e.message,
      };
    } finally {
      session.endSession();
    }
  }

  async cancelClient({ split }) {
    const session = await mongoose.connection.startSession();

    try {
      const { user } = this.context;
      const order = await this.model.findOne({
        client: user._id,
        split,
        status: {
          $nin: [
            OrderStatusType.CLIENT_CANCELED,
            OrderStatusType.OWNER_CANCELED,
            OrderStatusType.SYSTEM_CANCELED,
          ],
        },
      });

      if (!order) {
        throw new Error("Can't find your Order for this Split");
      }

      if (order.status !== OrderStatusType.PAID) {
        throw new Error(`Can't cancel Order at this stage: ${order.status}`);
      }

      let refund;

      await session.withTransaction(async () => {
        const { splits } = this.context.dataSources;

        order.status = OrderStatusType.CLIENT_CANCELED;
        await order.save({ session });

        await splits.exit({
          split,
          order,
          session,
          client: order.client,
          message: `${order.metadata.clientName} has cancelled his or her order'`,
        });

        //  Client cancels, don't refund application fee
        refund = await this.stripeService.refund(order.paymentIntent);
      });

      return {
        code: 200,
        success: true,
        order,
        refund,
      };
    } catch (e) {
      console.error(e);
      return {
        code: 501,
        success: false,
        message: e.message,
      };
    } finally {
      session.endSession();
    }
  }

  async requestRefund({ _id }) {
    const session = await mongoose.connection.startSession();

    try {
      const { user } = this.context;
      const order = this.get(_id);

      if (!order) {
        throw new Error("Can't find Order with provided id");
      }

      if (order.client !== user._id) {
        throw new Error(
          "Only the Order's client can request a refund for an Order"
        );
      }

      if (order.status !== OrderStatusType.COMPLETE) {
        throw new Error("Can't request Order refund at this stage");
      }

      const newOrder = await this.model.findOneAndUpdate(
        { _id },
        { status: OrderStatusType.REFUND_REQUESTED },
        { new: true }
      );

      return {
        code: 200,
        success: true,
        order: newOrder,
      };
    } catch (e) {
      return {
        code: 501,
        success: false,
        message: e.message,
      };
    } finally {
      session.endSession();
    }
  }

  async confirmRefund({ _id }) {
    const session = await mongoose.connection.startSession();

    try {
      const { user } = this.context;
      const order = this.get(_id);

      if (!order) {
        throw new Error("Can't find Order with provided id");
      }

      if (order.owner !== user._id) {
        throw new Error(
          "Only the Order's Owner can grant a refund for an Order"
        );
      }

      if (order.status !== OrderStatusType.REFUND_REQUESTED) {
        throw new Error('No refund request was made by the client');
      }

      let newOrder;
      let refund;

      await session.withTransaction(async () => {
        //  Client refund request granted, don't refund application fee
        refund = await this.stripeService.refund(order.paymentIntent);

        newOrder = await this.model.findOneAndUpdate(
          { _id },
          { status: OrderStatusType.REFUNDED },
          { new: true, session }
        );
      });

      return {
        code: 200,
        success: true,
        order: newOrder,
        refund,
      };
    } catch (e) {
      return {
        code: 501,
        success: false,
        message: e.message,
      };
    } finally {
      session.endSession();
    }
  }

  async markShipped({ _id }) {
    try {
      const { user } = this.context;
      const order = this.get(_id);

      if (!order) {
        throw new Error("Can't find Order with provided id");
      }

      if (order.owner !== user._id) {
        throw new Error("Only the Order's Owner can mark an Order as Shipped");
      }

      if (order.status !== OrderStatusType.PAID) {
        throw new Error("Can't mark order as Shipped at this stage");
      }

      const newOrder = await this.model.findOneAndUpdate(
        { _id },
        { status: OrderStatusType.SHIPPED },
        { new: true }
      );

      return {
        code: 200,
        success: true,
        order: newOrder,
      };
    } catch (e) {
      return {
        code: 501,
        success: false,
        message: e.message,
      };
    }
  }

  async markReceived({ _id }) {
    try {
      const { user } = this.context;
      const order = this.get(_id);

      if (!order) {
        throw new Error("Can't find Order with provided id");
      }

      if (order.client !== user._id) {
        throw new Error(
          "Only the Order's Client can mark an Order as Received"
        );
      }

      if (order.status !== OrderStatusType.SHIPPED) {
        throw new Error("Can't mark order as Received at this stage");
      }

      const newOrder = await this.model.findOneAndUpdate(
        { _id },
        { status: OrderStatusType.RECEIVED },
        { new: true }
      );

      return {
        code: 200,
        success: true,
        order: newOrder,
      };
    } catch (e) {
      return {
        code: 501,
        success: false,
        message: e.message,
      };
    }
  }
  async update({ _id, order }) {
    try {
      const newOrder = await this.model.findOneAndUpdate(
        { _id, client: this.context.user._id },
        order,
        { new: true }
      );
      return {
        code: 200,
        success: true,
        order: newOrder,
      };
    } catch (e) {
      return {
        code: 501,
        message: e.message,
      };
    }
  }

  async delete({ _id }) {
    try {
      await this.model.findOneAndUpdate(
        { _id, client: this.context.user._id },
        { status: OrderStatusType.DELETE }
      );

      return {
        code: 200,
        success: true,
      };
    } catch (e) {
      return {
        code: 501,
        success: false,
        message: e.message,
      };
    }
  }
}

const orderDataSource = {
  orders: new OrderDataSource(OrderModel),
};

const orderResolver = {
  OrderStatusType,
  Order: {
    owner(order, _, { dataSources: { users } }) {
      return users.nonNullGet(order.owner);
    },
    client(order, _, { dataSources: { users } }) {
      return users.nonNullGet(order.client);
    },
    split(order, _, { dataSources: { splits } }) {
      return splits.get(order.split);
    },
    paymentMethod: withCache(
      async (order, _, { dataSources: { orders } }) => {
        if (order.paymentIntent) {
          const paymentIntent = await orders.stripeService.getPaymentIntent({
            paymentIntent: order.paymentIntent,
          });

          if (paymentIntent.payment_method) {
            return await orders.stripeService.getPaymentMethod(
              paymentIntent.payment_method
            );
          }
        }
        return null;
      },
      { private: true, ttl: 2 * 480 * 1000 }
    ),
    shippingAddress: withCache(
      (order, _, { dataSources: { users } }) => {
        return users.getShippingAddressById(order.shippingAddress);
      },
      { private: true }
    ),
  },
  Query: {
    getOrderPaymentIntent(_, args, { dataSources: { orders } }) {
      return orders.getPaymentIntent(args);
    },
    order(_, args, { dataSources: { orders } }) {
      return orders.getOrder(args);
    },
    orders(_, args, { dataSources: { orders } }) {
      return orders.list(args);
    },
    myOrders(_, args, { dataSources: { orders } }) {
      return orders.myOrders();
    },
  },
  Mutation: {
    createOrder(_, args, { dataSources: { orders } }) {
      return orders.create(args);
    },
    cancelOrderOwner(_, args, { dataSources: { orders } }) {
      return orders.cancelOwner(args);
    },
    cancelOrderClient(_, args, { dataSources: { orders } }) {
      return orders.cancelClient(args);
    },
    // requestRefund(_, args, { dataSources: { orders } }) {
    //   return orders.requestRefund(args);
    // },
    // confirmRefund(_, args, { dataSources: { orders } }) {
    //   return orders.confirmRefund(args);
    // },
    markOrderShipped(_, args, { dataSources: { orders } }) {
      return orders.markShipped(args);
    },
    markOrderReceived(_, args, { dataSources: { orders } }) {
      return orders.markReceived(args);
    },
    updateOrder(_, args, { dataSources: { orders } }) {
      return orders.update(args);
    },
    deleteOrder(_, args, { dataSources: { orders } }) {
      return orders.delete(args);
    },
  },
};

module.exports = {
  orderTypes,
  orderResolver,
  orderDataSource,
  OrderModel,
  OrderStatusType,
};

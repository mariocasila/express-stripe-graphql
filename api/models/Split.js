const mongoose = require('mongoose');
const rake = require('rake-js');
const { DateTime } = require('luxon');
const { fieldsList } = require('graphql-fields-list');
const { isEmpty, max, unescape } = require('lodash');

const { MediaSchema } = require('../share/schemas');
const { BaseDataSource } = require('./BaseDataSource');
const { transformQuery } = require('../helpers/query');
const {
  keywordsPlugin,
  normalizeKeyword,
} = require('../helpers/keywords-plugin');
const { fetchProducts } = require('../services/woocommerce');
const { getMediaType } = require('../share/types');
const { schedule } = require('../services/scheduler');
const { TwilioService } = require('../services/twilio');

const { EventObjectType, SystemNotificationAction } = require('./Event');
const { OrderStatusType } = require('./Order');
const { UserRole } = require('./User');

const PER_PAGE = 20;

const SplitRoomMessageTypes = {
  CLIENT_JOINED: 'client-joined',
  CLIENT_EXITED: 'client-exited',
  EXPIRATION_NOTICE: 'expiration-notice',
  SPLIT_CREATED: 'split-created',
  SPLIT_CANCELLED: 'split-cancelled',
  SPLIT_COMPLETED: 'split-completed',
  SPLIT_RESET: 'split-reset',
  SPLIT_EXTENDED: 'split-extended',
};

const SplitType = {
  APP: 'APP',
  LEGACY: 'LEGACY',
};

const ShippingType = {
  INPERSON: 'INPERSON',
  SHIPPING: 'SHIPPING',
  VIRTUAL: 'VIRTUAL',
};

const SplitStatus = {
  ACTIVE: 'ACTIVE', //'Just what it means: active, available'
  FILLED: 'FILLED', //numPlacs == placesTaken
  EXPIRED: 'EXPIRED', // expirationDate < new Date()"
  CANCELLED: 'CANCELLED', //manually cancelled split, will also have cancelReason
  COMPLETE: 'COMPLETE', //"Complete as in Done"
};

const splitCancelMessage = (status, reason) => {
  switch (status) {
  case SplitStatus.EXPIRED:
    return "Oh no! The Split's time has ended and you don't have all the seats filled. All funds will be refunded within 7 days. Good luck in next Splits!";
  case SplitStatus.CANCELLED:
    return `Something went wrong! The Split's Creator cancelled this split${
      reason
        ? `, stating the reason: "${reason}". We hope this is a good reason.`
        : ". We hope there's a good reason."
    } All funds will be refunded within 7 days. Good luck in next Splits!`;
  default:
    return 'Something went wrong! This Split is now cancelled. All funds will be refunded within 7 days. Good luck in next Splits!';
  }
};

const splitTypes = `
  enum SplitType {
    ${Object.keys(SplitType).join('\n')}
  }

  enum ShippingType {
    ${Object.keys(ShippingType).join('\n')}
  }

  enum SplitStatus {
    ${Object.keys(SplitStatus).join('\n')}
  }

  interface Split {
    _id: ObjectID
    type: SplitType
    title: String
    tags:[String]
    categoryIds: [Int]
    categoryNames:[String]
    numPlaces: Int
    price: Float
    regularPrice: Float
    salePrice: Float
    splitPrices:[Float]
    "For legacy"    
    media: [PostMedia]

    rating: Float
    status: SplitStatus
    cancelReason: String    
    comments: [Comment]
    commentsCount: Int
    likes: Int
    liked: Boolean

    description: String
    keywords: [String]

    created_at: DateTime
    updated_at: DateTime
  }

  type Splits {
    total:Int
    max: Float
    data:[Split]
  }

  type LegacySplit implements Split {
    _id: ObjectID
    type: SplitType
    title: String
    tags:[String]
    categoryIds: [Int]
    categoryNames:[String]
    numPlaces: Int
    price: Float
    regularPrice: Float
    salePrice: Float
    splitPrices:[Float]
    "For legacy"    
    legacyUrl: String
    legacyId: String
    low: Int
    high: Int
    media: [PostMedia]

    rating: Float
    status: SplitStatus
    cancelReason: String    
    comments: [Comment]
    commentsCount: Int    
    likes: Int
    liked: Boolean

    description: String
    keywords: [String]

    created_at: DateTime
    updated_at: DateTime
  }

  type AppSplit implements Split {
    _id: ObjectID
    "Split Owner"
    user: User!    
    type: SplitType
    title: String
    tags:[String]
    categoryIds: [Int]
    categoryNames: [String]
    "Total number of places"
    numPlaces: Int
    "Number of seats taken"
    numSeats: Int
    "Cached from \`numSeats\` on createSplit so we are not confused later"
    ownerSeats: Int
    price: Float
    regularPrice: Float
    salePrice: Float
    splitPrices:[Float]
    "For legacy"    
    media: [PostMedia]

    "Use this to determine if Split can be ordered"
    placesLeft: Int

    "User has joined the Split"
    joined: Boolean

    shippingType: ShippingType
    "Collection field in design"
    shippingDetails: String
    expirationDate: DateTime
    rating: Float
    status: SplitStatus
    cancelReason: String
    
    comments: [Comment]
    commentsCount: Int
    likes: Int
    liked: Boolean

    "full Conversation, use when you need the full data"
    conversation: Conversation
    "just the id"
    conversationId: ObjectID
    "just the Twilio 'conversationId'"
    twilioConversationId: String

    description: String
    keywords: [String]

    created_at: DateTime
    updated_at: DateTime
  }

  input SplitSort {
    created_at: Int
    updated_at: Int    
    expirationDate: Int
    price: Int
  }

  input SplitQuery {
    _id: ObjectID
    title: String
    user:ObjectID
    isForYou: Boolean
    type: SplitType
    categoryIds: [Int]
    liked: Boolean
    priceFrom: Float
    priceTo: Float
    shippingType: ShippingType

    "This is always 'greater than'"
    placesLeft: Int

    "Use this for text search. It will be transformed into keywords and anything that matches will pop up"
    searchText: String
    "Use this for a manual keywords search"
    keywords: [String]

    created_at: DateTimeQuery
    updated_at: DateTimeQuery    
  }

  input CreateSplitInput {
    type: SplitType!
    title: String!
    tags:[String]
    categoryIds: [Int]
    categoryNames:[String]
    numPlaces: Int!
    numSeats: Int!
    price: Float!
    regularPrice: Float
    salePrice: Float
    splitPrices:[Float]
    "For legacy"
    legacyUrl: String

    legacyId: String
    media: [PostMediaInput]

    "For appsplit"
    shippingType: ShippingType!
    shippingDetails: String!
    expirationDate: DateTime

    description: String!
  }
  type SplitListResponse {
    max: Float
    total: Int
    data: [Split]
  }

  extend type Query {
    split(_id:ObjectID!):Split
    splits(query: SplitQuery,limit: Int, skip: Int, sort: SplitSort): SplitListResponse
    followedUserSplit(query: SplitQuery,limit: Int, skip: Int, sort: SplitSort): [Split]
    "Get the max \`price\` available for a Split right now, used in search filter"
    maxSplitPrice: Float
  }

  type CreateSplitResponse implements MutationResponse {
    code: String!
    success: Boolean!
    message: String
    split: Split
  }

  extend type Mutation {
    createSplit( split: CreateSplitInput! ): CreateSplitResponse
    updateSplit( _id: ObjectID!, split: CreateSplitInput! ): CreateSplitResponse
    cancelSplit(_id: ObjectID!, reason: String): CreateSplitResponse
    deleteSplit(_id: ObjectID!): CreateSplitResponse
    deleteAllSplit:Boolean
    bulkInsert:String
  }
`;

const SplitSchema = mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
    },
    user: {
      type: mongoose.Types.ObjectId,
      ref: 'User',
      index: true,
    },
    tags: [String],
    type: {
      type: String,
      required: true,
      index: true,
      enum: Object.values(SplitType),
    },
    productId: {
      type: Number,
      index: true,
    },
    categoryIds: {
      type: [Number],
    },
    categoryNames: {
      type: [String],
    },
    numPlaces: {
      type: Number,
      default: 1,
    },
    numSeats: {
      type: Number,
      default: 0,
    },
    ownerSeats: {
      type: Number,
      default: 0,
    },
    placesLeft: {
      type: Number,
      default: 1,
    },
    price: {
      type: Number,
      required: true,
    },
    regularPrice: Number,
    salePrice: Number,
    splitPrices: [Number],
    legacyUrl: String,
    legacyId: {
      type: Number,
      index: true,
    },
    media: [MediaSchema],

    description: {
      type: String,
    },

    /** it's for AppSplit */
    shippingType: {
      type: String,
      index: true,
      enum: Object.values(ShippingType),
    },
    shippingDetails: {
      type: String,
    },
    expirationDate: {
      type: Date,
    },
    rating: Number,
    status: {
      type: String,
      index: true,
      enum: Object.values(SplitStatus),
      default: SplitStatus.ACTIVE,
    },
    cancelReason: String,

    // Since it's a 1 to 1 relation with Split Room,
    // why not have it here and save loading time
    conversation: {
      type: mongoose.Types.ObjectId,
      ref: 'Conversation',
      index: true,
    },
    // Since this doesn't change, save some
    // more loading time by cahing twilioId on
    // Split too
    twilioConversationId: {
      type: String,
      index: true,
    },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    toJSON: { virtuals: true },
  }
);

const transformKeywords = (value, path) => {
  switch (path) {
  case 'description':
    return rake(value);
  default:
    return normalizeKeyword(value);
  }
};

SplitSchema.plugin(keywordsPlugin, {
  paths: ['title', 'type', 'description', 'tags'],
  transform: transformKeywords,
});

const SplitModel = mongoose.model('Split', SplitSchema);

class SplitDataSource extends BaseDataSource {
  initialize(config) {
    super.initialize(config);
    this.twilioService = new TwilioService();
  }

  async getForYouQuery() {
    const events = await this.context.dataSources.events.model.find(
      {
        user: this.context.user._id,
        type: EventObjectType.FOLLOW_USER,
      },
      ['followedUser']
    );

    const userIds = events.map((event) => event.followedUser);

    // const me = await this.context.dataSources.users.get(
    //   this.context.user._id
    // );
    // const tags = me.tags.map((tag) => toLower(tag));
    return {
      user: { $in: userIds },
      type: SplitType.APP,
      // tags: { $in: tags },
    };
  }

  async followedUserSplit({ query, limit, skip, sort }, fields = []) {
    const forYouQuery = await this.getForYouQuery();

    query = {
      ...query,
      ...forYouQuery,
    };

    return (await this.list({ query, limit, skip, sort }, fields)).data;
  }

  async list({ query = {}, limit, skip, sort }, fields) {
    // if (!query.user || query.user !== this.context.user._id.toString()) {
    //   query = {
    //     ...query,
    //     $and: [
    //       {
    //         $or: [
    //           { expirationDate: { $gte: DateTime.local() } },
    //           { expirationDate: undefined },
    //         ],
    //       },
    //     ],
    //   };
    // }

    if (query.categoryIds && query.categoryIds.length) {
      const categories = await this.context.dataSources.categories.list(
        {
          query: { categoryParentId: query.categoryIds },
        },
        { categoryId: 1 }
      );

      const categoryIds = categories.map((c) => c.categoryId) || [];
      query.categoryIds = { $in: query.categoryIds.concat(categoryIds) };
    } else if (query && query.categoryIds && !query.categoryIds.length) {
      query.categoryIds = [];
    }

    if (isEmpty(sort)) {
      sort = { created_at: -1 };
    }

    if (query.liked) {
      const likedSplitsEvents = await this.getLikedSplits(
        this.context.user._id
      );
      const likedSplits = likedSplitsEvents.map((ls) => ls.split);
      query = {
        ...query,
        _id: { $in: likedSplits },
      };
    }

    if (query.priceFrom) {
      query = {
        ...query,
        splitPrices: { $gte: query.priceFrom },
      };
    }

    if (query.priceTo) {
      if (query.splitPrices) {
        query.splitPrices = {
          ...query.splitPrices,
          $lte: query.priceTo,
        };
      } else {
        query.splitPrices = { $lte: query.priceTo };
      }
    }

    if (!isEmpty(query.title)) {
      query = {
        ...query,
        title: { $regex: query.title, $options: 'i' },
      };
    }

    if (query.isForYou) {
      const forYouQuery = await this.getForYouQuery();

      query = {
        ...query,
        ...forYouQuery,
      };
    }

    if (query.keywords) {
      query.keywords = { $in: query.keywords };
    } else if (query.searchText) {
      query.keywords = {
        $in: transformKeywords(query.searchText),
      };
    }

    //  Do not return full Splits by default but leave an option to get them
    const placesLeft = { $gt: query.placesLeft || 0 };

    delete query.searchText;
    delete query.liked;
    delete query.priceFrom;
    delete query.priceTo;
    delete query.isForYou;

    const $and = [
      transformQuery(query),
      {
        $or: [{ type: SplitType.LEGACY }, { placesLeft }],
      },
    ];

    if (!query.user || query.user !== this.context.user._id.toString()) {
      $and.push({
        $or: [
          { type: SplitType.LEGACY },
          { expirationDate: { $gte: DateTime.local() } },
        ],
      });
    }

    const maxSplitPrice = await this.getMaxPriceSplit({ query: { $and } });
    const total = await this.count({ query: { $and } });

    const splits = await this.model
      .find({ $and }, fields, { limit, skip, sort })
      .lean();

    return {
      max: maxSplitPrice,
      total: total,
      data: splits,
    };
  }

  async maxPrice() {
    return (await this.model.find({}, 'price').sort({ price: -1 }).limit(1))[0]
      .price;
  }

  async getMaxPriceSplit({ query = {} }) {
    delete query.splitPrices;

    const maxSplit = await this.model.findOne(query, { splitPrices: 1 }).sort({
      splitPrices: -1,
    });

    if (!maxSplit || !maxSplit.splitPrices || !maxSplit.splitPrices.length)
      return 0;

    return max(maxSplit.splitPrices);
  }

  async getLikedSplits({ _id }) {
    return await this.context.dataSources.events.list(
      {
        user: _id,
        type: EventObjectType.SPLIT_LIKE,
      },
      { split: 1 }
    );
  }

  async updateNumSeats({ _id, numSeats }, session) {
    await this.model.findOneAndUpdate(
      { _id },
      { numSeats: numSeats },
      { session }
    );
  }

  async incrementNumSeats({ _id, numSeats }, session) {
    const { conversations } = this.context.dataSources;

    const split = await this.model.findOneAndUpdate(
      { _id },
      {
        $inc: {
          numSeats,
          placesLeft: -numSeats,
        },
      },
      { session, new: true }
    );

    if (split.status === SplitStatus.ACTIVE && split.placesLeft <= 0) {
      split.status = SplitStatus.COMPLETE;
      await split.save({ session });

      await conversations.sendSystemMessage({
        conversation: split.conversation,
        message:
          'Congratulations! All the Seats are taken. Split Creator will process all of your orders soon. Stay tuned for updates.',
        attributes: {
          messageType: SplitRoomMessageTypes.SPLIT_COMPLETED,
          action: SystemNotificationAction.RATE_SPLIT,
          split: _id,
        },
      });
    } else if (split.status === SplitStatus.COMPLETE && split.placesLeft > 0) {
      split.status = SplitStatus.ACTIVE;
      await split.save({ session });

      await conversations.sendSystemMessage({
        conversation: split.conversation,
        message:
          'Oh no! Someone has cancelled his order and now Split is no longer complete',
        attributes: {
          messageType: SplitRoomMessageTypes.SPLIT_RESET,
          action: SystemNotificationAction.OPEN_CONVERSATION,
          conversation: split.conversation,
        },
      });
    }

    return split;
  }

  async updateUserSplitCount(user, session = null) {
    const { users } = this.context.dataSources;

    const numSplits = await this.model.countDocuments({ user });
    await users.model.findOneAndUpdate(
      { _id: user },
      { numSplits },
      { session }
    );
  }

  /**
   * Join a Split based on the Order created
   *
   * @param {Object} args
   * @param {ObjectID} args.split
   * @param {Order} args.order - full order
   * @param {User} args.client - full user
   * @param {'full' | 'readonly'} args.role
   * @param {MongooseSession} session
   * @returns {Promise<void>}
   */
  async join({ split, order, client, role = 'readonly', session }) {
    const { conversations } = this.context.dataSources;

    const conversation = await conversations.model.findOne(
      { split },
      '_id conversationId'
    );

    if (!conversation) {
      throw new Error('Conversation not found');
    }

    if (conversations.checkMember(conversation, client._id.toString())) {
      throw new Error('The Client is already a Conversation Member');
    }

    //  Update numSeats on the Split
    await this.incrementNumSeats(
      {
        _id: split,
        numSeats: order.numSeats,
      },
      session
    );

    //  As much as I like scripts to be as flat as possible,
    //  this should happen before the new user is actually subscribed
    //  to Push, so he doesn't receive a push notification
    //  about himself joining the Split
    const beforeSubscribe = async () => {
      //  Send a message to the conversation about the user Ordering a Split
      await conversations.sendSystemMessage({
        conversation: conversation._id,
        message: `${client.fullname} reserved ${order.numSeats} seats`,
        attributes: {
          messageType: SplitRoomMessageTypes.CLIENT_JOINED,
          action: SystemNotificationAction.OPEN_CONVERSATION,
          conversation: conversation._id,
        },
      });
    };
    //  Join the conversations associated with this Split automatically
    await conversations.join(
      conversation._id,
      client._id.toString(),
      session,
      role,
      { beforeSubscribe }
    );
  }

  /**
   *  Exit a Split and SplitRoom
   *
   *  @param split {ObjectID} - split in question
   *  @param client {ObjectID} - User that should be excluded
   *  @param order {Order} - Order object
   *  @param message {String} - Message that is attached to excluding a person
   *  @param session {Mongoose.Session} - for bulk operations
   * */
  async exit({ split, order, client, message, session }) {
    const { conversations } = this.context.dataSources;

    const splitData = await this.model.findOne(
      { _id: split },
      'numSeats conversation twilioConversationId'
    );

    if (!splitData.numSeats) {
      throw new Error(
        "Split has no seats taken. Who's supposed to exit and why did this happen?"
      );
    }

    const conversation = await conversations.model.findOne(
      { split },
      '_id conversationId'
    );

    if (!conversation) {
      throw new Error('Conversation not found');
    }

    if (!conversations.checkMember(conversation, client._id.toString())) {
      throw new Error('The Client is not a Conversation Member');
    }

    //  Update numSeats on the Split
    await this.incrementNumSeats(
      {
        _id: split,
        numSeats: -order.numSeats,
      },
      session
    );

    await conversations.deleteParticipant(
      conversation._id,
      client._id.toString(),
      session
    );

    //  Send a message to the conversation about the user Ordering a Split
    await conversations.sendSystemMessage({
      conversation: splitData.conversation,
      message,
      attributes: {
        messageType: SplitRoomMessageTypes.CLIENT_EXITED,
        action: SystemNotificationAction.OPEN_CONVERSATION,
        conversation: splitData.conversation,
      },
    });
  }

  async cancelAction({ _id, reason }) {
    try {
      const splitData = await this.get(_id);

      //  Cancel action if Split is already in one of the completed states
      if (
        [
          SplitStatus.COMPLETE,
          SplitStatus.EXPIRED,
          SplitStatus.CANCELLED,
        ].includes(splitData.status)
      ) {
        throw new Error('Split is already completed, cancelled or expired');
      }

      if (
        splitData.user.toString() !== this.context.user._id.toString() &&
        this.context.user.role !== UserRole.ADMIN
      ) {
        throw new Error('Only Split Owner can cancel a Split');
      }

      const split = await this.cancel({ _id, reason });

      return {
        code: 200,
        success: true,
        split,
      };
    } catch (e) {
      return {
        code: 501,
        success: false,
        message: e.message,
      };
    }
  }

  async expireNotifications(dry = false) {
    this.initialize();

    const { conversations } = this.context.dataSources;

    try {
      const dt4days = DateTime.now().plus({ days: 4 });
      const dt5days = DateTime.now().plus({ days: 5 });
      const dt1days = DateTime.now().plus({ days: 1 });

      const splits5days = await this.model.find(
        {
          expirationDate: {
            $gt: dt4days.toJSDate(),
            $lte: dt5days.toJSDate(),
          },
          status: {
            $nin: [
              SplitStatus.CANCELLED,
              SplitStatus.COMPLETE,
              SplitStatus.EXPIRED,
            ],
          },
        },
        '_id conversation'
      );

      const splits1days = await this.model.find(
        {
          expirationDate: {
            $gt: dt1days.toJSDate(),
            $lte: DateTime.now().toJSDate(),
          },
          status: {
            $nin: [
              SplitStatus.CANCELLED,
              SplitStatus.COMPLETE,
              SplitStatus.EXPIRED,
            ],
          },
        },
        '_id conversation'
      );

      if (dry) {
        console.log(splits5days, splits1days);
        return;
      }

      const promises = [];

      promises.push(
        splits5days.map((split) => {
          return conversations.sendSystemMessage({
            conversation: split.conversation,
            message: 'This Split will exjoinepire in 5 days if not filled',
            attributes: {
              messageType: SplitRoomMessageTypes.EXPIRATION_NOTICE,
              action: SystemNotificationAction.OPEN_CONVERSATION,
              conversation: split.conversation,
            },
          });
        })
      );

      promises.push(
        splits1days.map((split) => {
          return conversations.sendSystemMessage({
            conversation: split.conversation,
            message:
              'This Split will expire tomorrow in UTC time if not filled',
            attributes: {
              messageType: SplitRoomMessageTypes.EXPIRATION_NOTICE,
              action: SystemNotificationAction.OPEN_CONVERSATION,
              conversation: split.conversation,
            },
          });
        })
      );

      await Promise.allSettled(promises);
    } catch (e) {
      console.error('Error while sending expire notifications for Splits');
      console.error(e);
    }
  }

  /**
   *  We can afford to bulk expire Splits like this because it
   *  happens only once a day
   * */
  async expire(dry = false) {
    try {
      const toExpire = this.model.find(
        { expirationDate: { $lte: DateTime.local() } },
        '_id expirationDate'
      );

      if (dry) {
        console.log(toExpire);
        return;
      }

      const results = await Promise.allSettled(
        toExpire.map((split) =>
          this.cancel({
            _id: split._id,
            status: SplitStatus.EXPIRED,
          })
        )
      );

      results
        .filter((r) => !r.value.success)
        .every((r) => {
          console.error(new Error(r.value.message));
        });
    } catch (e) {
      console.error('Error while expiring splits');
      console.error(e);
    }
  }

  async cancel({ _id, reason, status = SplitStatus.CANCELLED }) {
    const { conversations, orders } = this.context.dataSources;

    const session = await mongoose.connection.startSession();

    try {
      const split = await this.get(_id);

      await session.withTransaction(async () => {
        //  Set all orders as ~OWNER_CANCELLED~ and refund.
        //  That's it, not exits via `SplitDataSource.exit` should happen here
        await orders.bulkCancel(
          { split: _id, status: OrderStatusType.OWNER_CANCELED },
          session
        );
        //  Set status as ~CANCELLED~ or whatever is provided
        //
        //  That's it, just change the status
        //
        //  We should not update `numSeats` or do anything else
        //  regarding the metadata. Essentially, the Split becomes freezed
        //  in the last state before the
        split.status = status;
        split.cancelReason = reason || null;

        await split.save({ session });

        //  Set everyone in ~Conversation~ to be readonly
        //
        //  We should not:
        //    - Delete the conversation
        //    - Delete the participants (including the Owner)
        //    - Post 99999 system messages when the Split is cancelled
        await conversations.makeReadonly({ split: _id });
        // Should send a system message to the ~Conversation~ that Split is cancelled by the Owner
        await conversations.sendSystemMessage({
          conversation: split.conversation,
          message: splitCancelMessage(status, reason),
          attributes: {
            messageType: SplitRoomMessageTypes.SPLIT_CANCELLED,
            action: SystemNotificationAction.OPEN_CONVERSATION,
            conversation: split.conversation,
          },
        });
      });

      return split;
    } catch (e) {
      console.error('Error in cancelling Split');
      console.error(e);
      throw e;
    } finally {
      session.endSession();
    }
  }

  async create({ split }) {
    const session = await mongoose.connection.startSession();
    try {
      split = {
        ...split,
        user: this.context.user._id,
      };

      if (split.numPlaces <= split.numSeats) {
        throw new Error("NumSeats can't be bigger than numPlaces");
      }

      split.placesLeft = (split.numPlaces || 0) - (split.numSeats || 0);
      //  Cache this initial number so we are not confused later
      split.ownerSeats = split.numSeats || 0;
      split.status = SplitStatus.ACTIVE;

      const user = await this.context.dataSources.users.get(
        this.context.user._id
      );

      if (
        !(await this.context.dataSources.users.stripeService.chargesEnabled(
          user.stripeAccountId
        ))
      ) {
        throw new Error(
          'This user is not eligible for payments yet. Use the onboarding link to enable this functionality'
        );
      }

      let newSplit, conversationData;

      await session.withTransaction(async () => {
        const { conversations } = this.context.dataSources;

        newSplit = await this.model.create([split], { session });

        const splitroom = {
          title: newSplit[0].title,
          split: newSplit[0]._id,
        };

        conversationData = await conversations.createSplitroom(
          splitroom,
          session
        );

        newSplit = await this.model.findOneAndUpdate(
          { _id: newSplit[0]._id },
          {
            conversation: conversationData[0]._id,
            twilioConversationId: conversationData[0].conversationId,
          },
          { new: true, session }
        );

        this.updateUserSplitCount(this.context.user._id, session);

        //  Send the first message to the conversation
        //  This probably should not go into the general notifications
        //  stream unless we later specifically require it to go there
        //  e.g. if you're following a person
        await this.twilioService.createMessage({
          conversationId: conversationData[0].conversationId,
          message: `${user.fullname} created this Split`,
          attributes: {
            messageType: SplitRoomMessageTypes.SPLIT_CREATED,
          },
        });
      });

      return {
        code: 200,
        success: true,
        split: !Array.isArray(newSplit) ? newSplit : newSplit[0] || null,
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

  async scheduleFetchFromWeb(log = false) {
    if (log) console.log('==== FETCHING LEGACY SPLITS ====');
    if (log) console.log('Removed old Splits');

    let page = 1;

    while (page) {
      if (await this.bulkInsert({ page, log })) {
        page++;
      } else {
        page = 0;
      }
    }

    if (log) console.log('==== DONE ====');
    return true;
  }

  async bulkInsert({ page, log }) {
    try {
      if (log) console.log(`Fetching Page ${page} of WooCommerce Splits`);

      const products = await fetchProducts({ page: page, per_page: PER_PAGE });

      if (log) console.log(`Done fetching Page ${page}`);

      if (products && products.data && products.data.length) {
        const splits = products.data.map((product) =>
          this.extractFromWannaSplitData(product)
        );

        await Promise.all(
          splits.map(async (split) => {
            await this.model.findOneAndUpdate(
              { legacyId: split.legacyId },
              split,
              {
                upsert: true,
              }
            );
          })
        );

        if (log)
          console.log(`Done inserting WooCommerce Splits of page ${page}`);

        return true;
      }
      return false;
    } catch (e) {
      console.error('Bulk insert Error');
      console.error(e);
      return false;
    }
  }

  extractFromWannaSplitData(product) {
    const media = product.images
      .filter((i) => i.src)
      .map((image) => {
        return {
          type: getMediaType(image.src),
          filename: image.name,
          src: image.src,
        };
      });

    const splitPriceMetas = product.meta_data.filter((meta) =>
      meta.key.includes('price_for')
    );

    return {
      legacyUrl: product.permalink,
      legacyId: product.id,
      title: product.name,
      type: SplitType.LEGACY,
      categoryIds: product.categories.map((category) => category.id) || [],
      categoryNames:
        product.categories.map((category) => unescape(category.name)) || [],
      tags: product.tags.map((tag) => tag.name),
      price: product.price ? +product.price : 0,
      regularPrice: product.regular_price ? +product.regular_price : 0,
      salePrice: product.sale_price ? +product.sale_price : 0,
      splitPrices:
        splitPriceMetas && splitPriceMetas.length
          ? splitPriceMetas.map((meta) => +meta.value).filter((v) => v !== 0)
          : null,
      numPlaces:
        splitPriceMetas && splitPriceMetas.length ? splitPriceMetas.length : 0,
      media: media,
    };
  }

  async delete({ _id }) {
    const response = await super.delete({ _id });

    this.updateUserSplitCount(this.context.user._id);

    return response;
  }

  async deleteAll(unauthenticated) {
    if (this.context.user.role === 'admin' && !unauthenticated) {
      await this.model.deleteMany({});
      return true;
    }
    throw new Error("You don' have role to this operator");
  }

  async update({ _id, split }) {
    try {
      const { user } = this.context;
      const { conversations } = this.context.dataSources;

      const splitData = await this.model.findOne({ _id });

      if (!splitData) {
        throw new Error('Split not found');
      }

      if (
        user._id.toString() !== splitData.user.toString() &&
        user.role !== 'admin'
      ) {
        throw new Error(
          "Forbidden. Only Split's owner or admin can update splits"
        );
      }

      if (split.numPlaces || split.numSeats) {
        split.placesLeft = (split.numPlaces || 0) - (split.numSeats || 0);
      }

      const updatedSplit = await this.model.findOneAndUpdate({ _id }, split, {
        new: true,
      });

      if (split.expirationDate) {
        const dateTemplate = DateTime.fromJSDate(split.expirationDate).toFormat(
          'yyyy LLL dd'
        );

        await conversations.sendSystemMessage({
          conversation: splitData.conversation,
          message: `Split expiration date was changed to ${dateTemplate}`,
          attributes: {
            messageType: SplitRoomMessageTypes.SPLIT_EXTENDED,
            action: SystemNotificationAction.OPEN_CONVERSATION,
            conversation: splitData.conversation,
          },
        });
      }

      return {
        code: 200,
        success: true,
        split: updatedSplit,
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

const splitDataSource = {
  splits: new SplitDataSource(SplitModel),
};

const AppResolvers = {
  user(split, _, { dataSources: { users } }) {
    return users.nonNullGet(split.user);
  },
  conversation(split, _, { dataSources: { conversations } }) {
    return conversations.get(split.conversation);
  },
  conversationId(split) {
    return split.conversation;
  },
  joined(split, _, { user, dataSources: { orders } }) {
    if (split.user == user._id) {
      return true;
    } else {
      return orders.bExists.load({
        status: {
          $nin: [
            OrderStatusType.SYSTEM_CANCELED,
            OrderStatusType.OWNER_CANCELED,
            OrderStatusType.CLIENT_CANCELED,
          ],
        },
        split: split._id,
        client: user._id,
      });
    }
  },
};

const commentsResolver = {
  comments(split, _, { dataSources: { comments } }) {
    return comments.batch.load({ split: split._id });
  },

  commentsCount(split, _, { dataSources: { comments } }) {
    return comments.bSplitCount.load({ split: split._id });
  },
};

const likesResolver = {
  likes(split, _, { dataSources: { events } }) {
    return events.bCount.load({
      type: EventObjectType.SPLIT_LIKE,
      split: split._id,
    });
  },
  liked(split, _, { user, unauthenticated, dataSources: { events } }) {
    if (unauthenticated) {
      return false;
    }

    return events.bExists.load({
      type: EventObjectType.SPLIT_LIKE,
      split: split._id,
      user: user._id,
    });
  },
};

const discountResolver = {
  low(split) {
    if (!split.price || !split.splitPrices || !split.splitPrices.length) {
      return 1;
    }
    return 100 - (split.splitPrices[0] / split.price).toFixed(2) * 100;
  },
  high(split) {
    if (!split.price || !split.splitPrices || !split.splitPrices.length) {
      return 0;
    }
    return (
      100 -
      (split.splitPrices[split.splitPrices.length - 1] / split.price).toFixed(
        2
      ) *
        100
    );
  },
};

const splitResolver = {
  SplitType,

  Split: {
    __resolveType(obj) {
      if (obj.type === SplitType.APP) return 'AppSplit';
      return 'LegacySplit';
    },
  },

  AppSplit: {
    ...AppResolvers,
    ...likesResolver,
    ...commentsResolver,
  },

  LegacySplit: {
    ...likesResolver,
    ...commentsResolver,
    ...discountResolver,
  },

  Query: {
    split(_, { _id }, { dataSources: { splits } }) {
      return splits.get(_id);
    },
    splits(_, args, { dataSources: { splits } }, info) {
      return splits.list(args, fieldsList(info, { path: 'data' }));
    },
    followedUserSplit(_, args, { dataSources: { splits } }, info) {
      return splits.followedUserSplit(args, fieldsList(info, { path: 'data' }));
    },
    maxSplitPrice(_, args, { dataSources: { splits } }) {
      return splits.maxPrice();
    },
  },

  Mutation: {
    createSplit(_, args, { dataSources: { splits } }) {
      return splits.create(args);
    },
    updateSplit(_, args, { dataSources: { splits } }) {
      return splits.update(args);
    },
    cancelSplit(_, args, { dataSources: { splits } }) {
      return splits.cancelAction(args);
    },
    deleteSplit(_, args, { dataSources: { splits } }) {
      return splits.delete(args);
    },
    deleteAllSplit(_, args, { unauthenticated, dataSources: { splits } }) {
      return splits.deleteAll(unauthenticated);
    },
    bulkInsert() {
      return SplitDataSource.scheduleFetchFromWeb(splitDataSource.splits, true);
    },
  },
};

const scheduleSplits = async () => {
  const time = {
    hour: 0,
    minute: 0,
    tz: 'Etc/UTC',
  };

  schedule('fetchProduct', time, () =>
    splitDataSource.splits.scheduleFetchFromWeb()
  );

  schedule('splitExpireNotifications', time, () =>
    splitDataSource.splits.expireNotifications()
  );

  schedule('splitExpire', time, () => splitDataSource.splits.expire());
};

const fetchManually = () => {
  return splitDataSource.splits.scheduleFetchFromWeb(true);
};

const testExpire = () => {
  return splitDataSource.splits.expireNotifications();
};

module.exports = {
  SplitModel,
  SplitStatus,
  SplitRoomMessageTypes,
  SplitType,
  splitTypes,
  splitResolver,
  splitDataSource,
  scheduleSplits,
  fetchManually,
  testExpire,
};

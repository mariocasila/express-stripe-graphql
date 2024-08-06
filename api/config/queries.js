const MESSAGE_FRAGMENT = `
  fragment TwilioMessage on TwilioMessage {
    body
    attributes
    links
  }
`;

const CONVERSATION_FRAGMENT = `
fragment Conversation on Conversation {
  _id
  users {
    _id
    fullname
    username
    email
    participantId
  }
  owner {
    _id
    fullname
    username
    email
  }
  conversationId
  participants {
    sid
    identity
  }
  type
  status
  created_at
  updated_at
  ... on Community {
    title
    description
    thumbnail {
      src
    }
    admins {
      _id
    }
    isAdmin
    isOwner
    messages {
      ...TwilioMessage
    }
  }
  ... on Tribe {
    title
    description
    color
    admins {
      _id
    }
    isAdmin
    isOwner
    messages {
      ...TwilioMessage
    }
  }
}
${MESSAGE_FRAGMENT}
`;

const APP_SPLIT_FRAGMENT = `
  fragment AppSplit on AppSplit {
    _id
    user {
      _id
    }
    type
    title
    tags
    joined
    twilioConversationId
    conversationId
    categoryNames
    description
    numPlaces
    numSeats
    placesLeft
    price
    regularPrice
    splitPrices
    salePrice
    media {
      src
    }
    conversation {
      _id
      conversationId
    }
    commentsCount
    shippingType
    shippingDetails
    expirationDate
    rating
    status
    cancelReason
    likes
    liked
  }
`;

const LEGACY_SPLIT_FRAGMENT = `
  fragment LegacySplit on LegacySplit {
    _id
    type
    title
    tags
    categoryNames
    description
    numPlaces
    price
    regularPrice
    salePrice
    splitPrices
    legacyUrl
    legacyId
    media {
      src
    }
    low
    high
    commentsCount
    rating
    status
    cancelReason
    likes
    liked
  }
`;

const CREATE_CONVERSATION = `
mutation createConversation($conversation: ConversationInput!) {
  createConversation(conversation: $conversation) {
    code
    success
    message
    conversation {
      ...Conversation
    }
  }
}
${CONVERSATION_FRAGMENT}
`;

const UPDATE_CONVERSATION = `
mutation updateConversation($_id: ObjectID!, $conversation: UpdateConversationInput!) {
  updateConversation(_id: $_id, conversation: $conversation) {
    code
    success
    message
    conversation {
      ...Conversation
    }
  }
}
${CONVERSATION_FRAGMENT}
`;

const DELETE_CONVERSATION = `
mutation deleteConversation($conversation: ObjectID!) {
  deleteConversation(conversation: $conversation) {
    code
    success
    message
    conversation {
      ...Conversation
    }
  }
}
${CONVERSATION_FRAGMENT}
`;

const JOIN_CONVERSATION = `
mutation joinConversation($conversation: ObjectID!) {
  joinConversation(conversation: $conversation) {
    code
    success
    message
    conversation {
      ...Conversation
    }
  }
}
${CONVERSATION_FRAGMENT}
`;

const LEAVE_CONVERSATION = `
mutation leaveConversation($conversation: ObjectID!) {
  leaveConversation(conversation: $conversation) {
    code
    success
    message
    conversation {
      ...Conversation
    }
  }
}
${CONVERSATION_FRAGMENT}
`;

const MY_CONVERSATIONS = `
query MyConversations($query: ConversationQuery, $limit: Int, $skip: Int, $sort: ConversationSort) {
  myConversations(query: $query, limit: $limit, skip: $skip, sort: $sort) {
    ...Conversation
  }
}
${CONVERSATION_FRAGMENT}
`;

const CONVERSATIONS = `
query getConversations($query: ConversationQuery, $limit: Int, $skip: Int, $sort: ConversationSort) {
  conversations(query: $query, limit: $limit, skip: $skip, sort: $sort) {
    ...Conversation
  }
}
${CONVERSATION_FRAGMENT}
`;

const ADD_ADMIN = `
mutation AddAdmin($conversation: ObjectID!, $user: ObjectID!) {
  addAdmin(conversation: $conversation, user: $user) {
    code
    success
    message
    conversation {
      ...Conversation
    }
  }
}
${CONVERSATION_FRAGMENT}
`;

const DELETE_ADMIN = `
mutation DeleteAdmin($conversation: ObjectID!, $user: ObjectID!) {
  deleteAdmin(conversation: $conversation, user: $user) {
    code
    success
    message
    conversation {
      ...Conversation
    }
  }
}
${CONVERSATION_FRAGMENT}
`;

const DELETE_PARTICIPANT = `
mutation DeleteParticipant($conversation: ObjectID!, $user: ObjectID!) {
  deleteParticipant(conversation: $conversation, user: $user) {
    code
    success
    message
    conversation {
      ...Conversation
    }
  }
}
${CONVERSATION_FRAGMENT}
`;

const CREATE_SPLIT = `
  mutation CreateSplit($split: CreateSplitInput!) {
    createSplit(split: $split) {
      code
      success
      message
      split {
        ... on AppSplit {
          ...AppSplit
        }
        ... on LegacySplit {
          ...LegacySplit
        }
      }
    }
  }
  ${APP_SPLIT_FRAGMENT}
  ${LEGACY_SPLIT_FRAGMENT}
`;

const GET_SPLITS = `
query getSplits(
  $query: SplitQuery
  $limit: Int
  $skip: Int
  $sort: SplitSort
) {
  splits(query: $query, limit: $limit, skip: $skip, sort: $sort) {
    max
    total
    data {
      ... on AppSplit {
        ...AppSplit
      }
      ... on LegacySplit {
        ...LegacySplit
      }
    }
  }
}
${APP_SPLIT_FRAGMENT}
${LEGACY_SPLIT_FRAGMENT}
`;

const GET_TWILIO_TOKEN = `
  query GetTwilioAccessToken($platform: Platform) {
    getTwilioAccessToken(platform: $platform)
  }
`;

const DELETE_USER = `
mutation DeleteUser{
  deleteUser{
    code
    success
    message
  }
}
`;

module.exports = {
  CREATE_CONVERSATION,
  UPDATE_CONVERSATION,
  DELETE_CONVERSATION,
  JOIN_CONVERSATION,
  LEAVE_CONVERSATION,
  MY_CONVERSATIONS,
  CONVERSATIONS,

  ADD_ADMIN,
  DELETE_ADMIN,
  DELETE_PARTICIPANT,

  GET_SPLITS,
  CREATE_SPLIT,

  DELETE_USER,

  GET_TWILIO_TOKEN,
};

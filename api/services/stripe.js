const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const isEmpty = require('lodash/isEmpty');

const StripePaymentStatusType = {
  REQUIRE_PAYMENT_METHOD: 'requires_payment_method',
  REQUIRE_CONFIRMATION: 'requires_confirmation',
  REUIRE_ACTION: 'requires_action',
  FAILED: 'payment_failed',
  PROCESSING: 'processing',
  CANCELED: 'canceled',
  SUCCESS: 'succeeded',
};

const stripeTypes = `
  type StripeAccountLink {
    created: DateTime
    expires_at: DateTime
    url: String!
  }

  type StripeCustomer {
    id: String
    object: String
  }

  enum StripePaymentStatus {
    ${Object.values(StripePaymentStatusType).join('\n')}
  }  

  type StripePaymentIntent {
    amount: String
    amount_received: String
    application_fee_amount: String
    livemode: Boolean
    payment_method: String
    payment_method_types: [String]
  }

  type Address {
    city: String
    country: String
    line1: String
    line2: String
    postal_code: String
    state: String
  }

  type StripeBillingDetails {
    address: Address
    email: String
    name: String
    phone: String
  }

  type StripeCardNetworks {
    available: [String]
    preferred: String
  }

  type ThreeDSecureUsage {
    supported: Boolean
  }

  type StripeCard {
    brand: String
    country: String
    exp_month: Int
    exp_year: Int
    fingerprint: String
    funding: String
    generated_from: String
    last4: String
    networks: StripeCardNetworks
    three_d_secure_usage: ThreeDSecureUsage
    wallet: String
  }

  type StripePaymentMethod {
    id: String
    billing_details: StripeBillingDetails
    card: StripeCard
    created: Int
    customer: String
    livemode: Boolean
  }

  type StripePaymentInfo {
    customer: StripeCustomer
    ephemeralKey: String
    paymentIntent: StripePaymentIntent
    publishableKey: String
  }
`;

/**
 *  14 Jul 2022, Yurii:
 *    I want to use TypeScript so much :DD
 * */
class StripeService {
  /**
   * Creates Stripe Customer and Stripe Account
   * and returns necessary props for user
   *
   * @param user - User Model object
   *
   * @returns customer
   * @returns account
   * */
  async setupUser(user) {
    const customer = user.fullname
      ? await this.createCustomer({ name: user.fullname })
      : false;
    const account = await this.createExpressAccount();

    return { customer, account };
  }

  transformAccountLink(accountLink) {
    return {
      created: new Date(accountLink.created * 1000),
      expires_at:
        accountLink.expires_at && new Date(accountLink.expires_at * 1000),
      url: accountLink.url,
    };
  }

  async createCustomer(args) {
    return await stripe.customers.create(args);
  }

  async updateCustomerName(customerId, name) {
    return await stripe.customers.update(customerId, { name });
  }

  /**
   * @param id String - customer id
   * */
  async getCustomer(id) {
    return await stripe.customers.retrieve(id);
  }

  /**
   * @param customer String - customer id
   * */
  createEphemeralKey(customer) {
    return stripe.ephemeralKeys.create(
      { customer },
      { apiVersion: '2020-08-27' }
    );
  }

  /**
   * @param customer String - customer id
   * @param destination String - connected express account id
   * @param amount Number - customer id
   * @param currency String - Stripe Currency
   * */
  async createPaymentIntent({
    customer,
    destination,
    amount,
    feeAmount,
    currency = 'usd',
  }) {
    return await stripe.paymentIntents.create({
      // TODO: we need to pay as a smallest unit, for USD we need to pay as cents
      // temporarily we are using only cents. we need to do later with other currency
      amount,
      currency,
      customer,
      transfer_data: {
        destination,
      },
      payment_method_types: ['card'],
      application_fee_amount: feeAmount,
    });
  }

  async getPaymentIntent(paymentIntent) {
    try {
      return await stripe.paymentIntents.retrieve(paymentIntent);
    } catch (e) {
      return null;
    }
  }

  async cancelPaymentIntent(paymentIntent) {
    return await stripe.paymentIntents.cancel(paymentIntent);
  }

  async getPaymentMethods(id) {
    return await stripe.customers.listPaymentMethods(id, { type: 'card' });
  }

  async getPaymentMethod(id) {
    return await stripe.paymentMethods.retrieve(id);
  }

  async getAccount(id) {
    return await stripe.accounts.retrieve(id);
  }

  async createExpressAccount() {
    return await stripe.accounts.create({ type: 'express' });
  }

  /**
   *  Login link is used to change Express Account's
   *  details after it has been onboarded already
   * */
  async getLoginLink(account) {
    return stripe.accounts
      .createLoginLink(account)
      .then((link) => this.transformAccountLink(link));
  }

  /**
   *  Used to get Express Account's Onboarind Link.
   *  Unfortunately, Express accounts can't get `account_update` links
   *  and it's necessary to use Login Link instead
   * */
  async getAccountLink(account, type = 'account_onboarding') {
    //  The onboarding link
    const accountLink = await stripe.accountLinks.create({
      account,
      type,
      refresh_url: `${process.env.DOMAIN_PREFIX}/stripe_refresh`,
      return_url: `${process.env.DOMAIN_PREFIX}/stripe_return`,
    });

    return this.transformAccountLink(accountLink);
  }

  async chargesEnabled(id) {
    const account = await this.getAccount(id);
    return account.charges_enabled;
  }

  async detailsSubmitted(id) {
    const account = await this.getAccount(id);
    return account.details_submitted;
  }

  async verifyWebhook(data, signature) {
    return await stripe.webhooks.constructEvent(
      data,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  }

  /**
   * Refund the Order
   *
   *  https://stripe.com/docs/connect/destination-charges#issuing-refunds
   *
   *  Issuing refunds using Stripe Connect works a little differently than
   *  in regular Stripe usage. We're using `reverse_transfer` to pull funds
   *  from the Express account so
   *
   * @param piid String - paymentIntent id
   * @param refund_application_fee Boolean - Whether or not to refund the application fee
   *
   * */
  async refund(piid, refund_application_fee = false) {
    const paymentIntent = await stripe.paymentIntents.retrieve(piid);

    if (!paymentIntent) {
      throw new Error('paymentIntent doesn\'t exist');
    }

    if (paymentIntent.status !== StripePaymentStatusType.SUCCESS) {
      throw new Error('paymentIntent is not successful');
    }

    if (isEmpty(paymentIntent.charges)) {
      throw new Error('paymentIntent doesn\'t have charges');
    }

    const refund = await stripe.refunds.create({
      charge: paymentIntent.charges.data[0].id,
      reverse_transfer: true,
      refund_application_fee,
    });

    return { refund };
  }
}

module.exports = {
  StripePaymentStatusType,
  StripeService,
  stripeTypes,
};

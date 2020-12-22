// @ts-check
import '@agoric/zoe/exported';
import { E } from '@agoric/eventual-send';
import { makeLocalAmountMath } from '@agoric/ertp';
import { makeStore } from '@agoric/store';
import { passStyleOf } from '@agoric/marshal';
import { assert, details } from '@agoric/assert';

export const makeHelpers = (homePromise, endowments) => {
  const { zoe, wallet, board } = E.G(homePromise);

  const walletAdmin = E(wallet).getAdminFacet();
  const installationManager = E(walletAdmin).getInstallationManager();

  const zoeInvitationPurse = E(walletAdmin).getPurse(
    'Default Zoe invite purse',
  );

  const install = async (resolvedPath, contractPetname) => {
    const bundle = await endowments.bundleSource(resolvedPath);
    const installation = await E(zoe).install(bundle);

    await E(installationManager).add(contractPetname, installation);

    console.log('- SUCCESS! contract code installed on Zoe');
    console.log(`-- Contract Name: ${contractPetname}`);

    const id = await E(board).getId(installation);
    return { installation, id };
  };

  const resolvePathForLocalContract = contractPath =>
    endowments.pathResolve(contractPath);

  const resolvePathForPackagedContract = contractPath =>
    require.resolve(contractPath);

  const withdrawInvitation = async invitationDetails => {
    // Let's go with the first one that fits our requirements
    const invitationAmount = await E(walletAdmin).findInvitationAmount(
      invitationDetails,
    );
    return E(zoeInvitationPurse).withdraw(invitationAmount);
  };

  /** @typedef {string} Petname */

  /** @type {Store<Petname,AmountMath>} */
  const localAmountMath = makeStore('petname');

  const saveLocalAmountMath = async petname => {
    const issuer = E(walletAdmin).getIssuer(petname);
    const amountMath = await makeLocalAmountMath(issuer);
    localAmountMath.init(petname, amountMath);
  };

  const saveAllLocalAmountMath = async petnames => {
    return Promise.all(petnames.map(saveLocalAmountMath));
  };

  const makeAmount = amountWithPetnames => {
    const { brand: brandPetname, value } = amountWithPetnames;
    const math = localAmountMath.get(brandPetname);
    return math.make(value);
  };

  const makeProposalPart = giveOrWant => {
    return Object.fromEntries(
      Object.entries(giveOrWant).map(([keyword, amountWithPetnames]) => {
        const amount = makeAmount(amountWithPetnames);
        return [keyword, amount];
      }),
    );
  };

  const makeProposal = proposalWithPetnames => {
    const { want, give } = proposalWithPetnames;

    return harden({
      want: makeProposalPart(want || {}),
      give: makeProposalPart(give || {}),
      exit: proposalWithPetnames.exit,
    });
  };

  const withdrawPayments = (proposal, paymentsWithPursePetnames) => {
    return Object.fromEntries(
      Object.entries(paymentsWithPursePetnames).map(
        ([keyword, pursePetname]) => {
          const purse = E(walletAdmin).getPurse(pursePetname);
          const amountToWithdraw = proposal.give[keyword];
          const paymentP = E(purse).withdraw(amountToWithdraw);
          return [keyword, paymentP];
        },
      ),
    );
  };

  const getInvitation = (invitation, invitationDetails) => {
    if (invitation !== undefined) {
      return invitation;
    }
    assert(
      invitationDetails,
      `either an invitation or invitationDetails is required`,
    );
    return withdrawInvitation(invitationDetails);
    // TODO: handle instancePetname instead of instance
  };

  const depositPayouts = (seat, payoutPursePetnames) => {
    const makeDepositInPurse = keyword => payment => {
      const purse = payoutPursePetnames[keyword];
      E(purse).deposit(payment);
    };
    const handlePayments = paymentsP => {
      Object.entries(paymentsP).forEach(([keyword, paymentP]) => {
        const depositInPurse = makeDepositInPurse(keyword);
        paymentP.then(depositInPurse);
      });
    };
    const paymentsPP = E(seat).getPayouts();
    return paymentsPP.then(handlePayments);
  };

  const makeSaveOfferResult = fullInvitationDetailsP => async offerResult => {
    // TODO: move entire offer process to wallet
    const fullInvitationDetails = await fullInvitationDetailsP;
    await E(walletAdmin).saveOfferResult(
      fullInvitationDetails.handle,
      offerResult,
    );
  };

  const makeOffer = offerConfig => {
    const {
      invitation,
      invitationDetails,
      proposalWithBrandPetnames,
      paymentsWithPursePetnames,
      payoutPursePetnames,
    } = offerConfig;

    const invitationToUse = getInvitation(invitation, invitationDetails);
    const fullInvitationDetailsP = E(zoe).getInvitationDetails(invitationToUse);
    const proposal = makeProposal(proposalWithBrandPetnames);
    const payments = withdrawPayments(proposal, paymentsWithPursePetnames);

    const seat = E(zoe).offer(invitationToUse, proposal, payments);

    const deposited = depositPayouts(seat, payoutPursePetnames);

    const offerResultP = E(seat).getOfferResult();
    const saveOfferResult = makeSaveOfferResult(fullInvitationDetailsP);
    offerResultP.then(saveOfferResult);
    return {
      seat,
      deposited,
      invitationDetailsPromise: fullInvitationDetailsP,
    };
  };

  const makeIssuerKeywordRecord = issuerPetnameKeywordRecord => {
    return Object.fromEntries(
      Object.entries(issuerPetnameKeywordRecord).map(
        ([keyword, issuerPetname]) => {
          const issuerP = E(walletAdmin).getIssuer(issuerPetname);
          return [keyword, issuerP];
        },
      ),
    );
  };

  const getIssuerKeywordRecord = (
    issuerKeywordRecord,
    issuerPetnameKeywordRecord,
  ) => {
    if (issuerKeywordRecord !== undefined) {
      return issuerKeywordRecord;
    }
    return makeIssuerKeywordRecord(issuerPetnameKeywordRecord);
  };

  const startInstance = async config => {
    const {
      instancePetname,
      installation,
      issuerKeywordRecord,
      issuerPetnameKeywordRecord,
      terms,
    } = config;

    const issuerKeywordRecordToUse = getIssuerKeywordRecord(
      issuerKeywordRecord,
      issuerPetnameKeywordRecord,
    );
    const startInstanceResult = await E(zoe).startInstance(
      installation,
      issuerKeywordRecordToUse,
      terms,
    );

    const {
      creatorFacet,
      publicFacet,
      instance,
      creatorInvitation,
      adminFacet,
    } = startInstanceResult;

    const instanceManager = E(walletAdmin).getInstanceManager();
    await E(instanceManager).add(instancePetname, instance);

    if (passStyleOf(creatorInvitation) === 'presence') {
      const invitationAmount = await E(zoeInvitationPurse).deposit(
        creatorInvitation,
      );
      const invitationDetails = invitationAmount.value[0];
      return {
        creatorFacet,
        publicFacet,
        instance,
        adminFacet,
        invitationDetails,
      };
    }

    return startInstanceResult;
  };

  const saveIssuerFromFacet = async (
    facet,
    getIssuerMethod,
    brandPetname,
    pursePetname,
  ) => {
    // This await appears to be necessary, otherwise I get a kernel
    // panic :/
    const issuer = await E(facet)[getIssuerMethod]();

    await E(walletAdmin).addIssuer(brandPetname, issuer);
    const emptyPurseMadeP = E(walletAdmin).makeEmptyPurse(
      brandPetname,
      pursePetname,
    );
    const localAmountMathSavedP = saveLocalAmountMath(brandPetname);

    return Promise.all([emptyPurseMadeP, localAmountMathSavedP]);
  };

  const getInvitationFromFacet = (facet, makeInvitationMethod) => {
    return E(facet)[makeInvitationMethod]();
  };

  const depositInvitationFromFacet = async (facet, makeInvitationMethod) => {
    const invitation = await getInvitationFromFacet(
      facet,
      makeInvitationMethod,
    );
    // Deposit returns the amount deposited
    const invitationAmount = await E(zoeInvitationPurse).deposit(invitation);
    return invitationAmount.value[0];
  };

  const assertOfferResult = async (seat, expectedOfferResult) => {
    const actualOfferResult = await E(seat).getOfferResult();
    assert(
      actualOfferResult === expectedOfferResult,
      details`offerResult (${actualOfferResult}) did not equal expected: ${expectedOfferResult}`,
    );
  };

  return {
    install,
    resolvePathForLocalContract,
    resolvePathForPackagedContract,
    makeIssuerKeywordRecord,
    makeOffer,
    saveLocalAmountMath,
    saveAllLocalAmountMath,
    startInstance,
    saveIssuerFromFacet,
    depositInvitationFromFacet,
    assertOfferResult,
    getInvitationFromFacet,
  };
};

import { SagaIterator, delay } from 'redux-saga';
import {
  call,
  cancel,
  apply,
  cancelled,
  fork,
  put,
  select,
  take,
  takeEvery,
  race,
  takeLatest
} from 'redux-saga/effects';
import moment from 'moment';

import { getOrderStatus, postOrder, getAllRates } from 'api/bity';
import shapeshift from 'api/shapeshift';
import * as configSelectors from 'features/config/selectors';
import * as transactionFieldsActions from 'features/transaction/fields/actions';
import * as transactionMetaActions from 'features/transaction/meta/actions';
import * as transactionTypes from 'features/transaction/types';
import * as transactionActions from 'features/transaction/actions';
import * as walletTypes from 'features/wallet/types';
import * as walletActions from 'features/wallet/actions';
import * as walletSelectors from 'features/wallet/selectors';
import * as notificationsActions from 'features/notifications/actions';
import * as swapTypes from './types';
import * as swapActions from './actions';
import * as swapSelectors from './selectors';

//#region Lite Send
export function* configureLiteSendSaga(): SagaIterator {
  const { amount, label }: swapTypes.SwapState['origin'] = yield select(swapSelectors.getOrigin);
  const paymentAddress: swapTypes.SwapState['paymentAddress'] = yield call(fetchPaymentAddress);

  if (!paymentAddress) {
    yield put(notificationsActions.showNotification('danger', 'Could not fetch payment address'));
    return yield put(swapActions.showLiteSend(false));
  }

  const supportedUnit: boolean = yield select(configSelectors.isSupportedUnit, label);
  if (!supportedUnit) {
    return yield put(swapActions.showLiteSend(false));
  }

  const unlocked: boolean = yield select(walletSelectors.isUnlocked);
  yield put(swapActions.showLiteSend(true));

  // wait for wallet to be unlocked to continue
  if (!unlocked) {
    yield take(walletTypes.WalletActions.SET);
  }
  const isNetwrkUnit = yield select(configSelectors.isNetworkUnit, label);
  //if it's a token, manually scan for that tokens balance and wait for it to resolve
  if (!isNetwrkUnit) {
    yield put(walletActions.setTokenBalancePending({ tokenSymbol: label }));
    yield take([
      walletTypes.WalletActions.SET_TOKEN_BALANCE_FULFILLED,
      walletTypes.WalletActions.SET_TOKEN_BALANCE_REJECTED
    ]);
  } else {
    const etherBalanceResolving: boolean = yield select(walletSelectors.isEtherBalancePending);
    if (etherBalanceResolving) {
      yield take([
        walletTypes.WalletActions.SET_BALANCE_FULFILLED,
        walletTypes.WalletActions.SET_BALANCE_REJECTED
      ]);
    }
  }

  yield put(transactionMetaActions.setUnitMeta(label));
  yield put(transactionActions.setCurrentValue(amount.toString()));
  yield put(transactionActions.setCurrentTo(paymentAddress));
}

export function* handleConfigureLiteSend(): SagaIterator {
  while (true) {
    const liteSendProc = yield fork(configureLiteSendSaga);
    const result = yield race({
      transactionReset: take(transactionTypes.TransactionActions.RESET_REQUESTED),
      userNavigatedAway: take(walletTypes.WalletActions.RESET),
      bityPollingFinished: take(swapTypes.SwapActions.STOP_POLL_BITY_ORDER_STATUS),
      shapeshiftPollingFinished: take(swapTypes.SwapActions.STOP_POLL_SHAPESHIFT_ORDER_STATUS)
    });

    //if polling is finished we should clear state and hide this tab
    if (result.bityPollingFinished || result.shapeshiftPollingFinished) {
      //clear transaction state and cancel saga
      yield cancel(liteSendProc);
      yield put(swapActions.showLiteSend(false));
      return yield put(transactionFieldsActions.resetTransactionRequested());
    }
    if (result.transactionReset) {
      yield cancel(liteSendProc);
    }

    // if wallet reset is called, that means the user navigated away from the page, so we cancel everything
    if (result.userNavigatedAway) {
      yield cancel(liteSendProc);
      yield put(swapActions.showLiteSend(false));
      return yield put(swapActions.configureLiteSend());
    }
    // else the user just swapped to a new wallet, and we'll race against liteSend again to re-apply
    // the same transaction parameters again
  }
}

export function* fetchPaymentAddress(): SagaIterator {
  const MAX_RETRIES = 5;
  let currentTry = 0;
  while (currentTry <= MAX_RETRIES) {
    yield call(delay, 500);
    const paymentAddress: swapTypes.SwapState['paymentAddress'] = yield select(
      swapSelectors.getPaymentAddress
    );
    if (paymentAddress) {
      return paymentAddress;
    }
    currentTry++;
  }

  yield put(notificationsActions.showNotification('danger', 'Payment address not found'));
  return false;
}

export function* swapLiteSendSaga(): SagaIterator {
  yield takeEvery(swapTypes.SwapActions.CONFIGURE_LITE_SEND, handleConfigureLiteSend);
}
//#endregion Lite Send

//#region Orders
export const ONE_SECOND = 1000;
export const TEN_SECONDS = ONE_SECOND * 10;
export const ORDER_TIMEOUT_MESSAGE = `
    Time has run out.
    If you have already sent, please wait 1 hour.
    If your order has not be processed after 1 hour,
    please press the orange 'Issue with your Swap?' button.
`;
export const ORDER_RECEIVED_MESSAGE = `
    The order was recieved.
    It may take some time to process the transaction.
    Please wait 1 hour. If your order has not been processed by then,
    please press the orange 'Issue with your Swap?' button.
`;

export function* pollBityOrderStatus(): SagaIterator {
  try {
    let swap = yield select(swapSelectors.getSwap);
    while (true) {
      yield put(swapActions.bityOrderStatusRequested());
      const orderStatus = yield call(getOrderStatus, swap.orderId);
      if (orderStatus.error) {
        yield put(
          notificationsActions.showNotification(
            'danger',
            `Bity Error: ${orderStatus.msg}`,
            TEN_SECONDS
          )
        );
      } else {
        yield put(swapActions.bityOrderStatusSucceededSwap(orderStatus.data));
        yield call(delay, ONE_SECOND * 5);
        swap = yield select(swapSelectors.getSwap);
        if (swap === 'CANC') {
          break;
        }
      }
    }
  } finally {
    if (yield cancelled()) {
      // TODO - implement request cancel if needed
      // yield put(actions.requestFailure('Request cancelled!'))
    }
  }
}

export function* pollShapeshiftOrderStatus(): SagaIterator {
  try {
    let swap = yield select(swapSelectors.getSwap);
    while (true) {
      yield put(swapActions.shapeshiftOrderStatusRequested());
      const orderStatus = yield apply(shapeshift, shapeshift.checkStatus, [swap.paymentAddress]);
      if (orderStatus.status === 'failed') {
        yield put(
          notificationsActions.showNotification(
            'danger',
            `Shapeshift Error: ${orderStatus.error}`,
            Infinity
          )
        );
        yield put(swapActions.stopPollShapeshiftOrderStatus());
      } else {
        yield put(swapActions.shapeshiftOrderStatusSucceededSwap(orderStatus));
        yield call(delay, ONE_SECOND * 5);
        swap = yield select(swapSelectors.getSwap);
        if (swap === 'CANC') {
          break;
        }
      }
    }
  } finally {
    if (yield cancelled()) {
      // Request canclled
    }
  }
}

export function* pollBityOrderStatusSaga(): SagaIterator {
  while (yield take(swapTypes.SwapActions.START_POLL_BITY_ORDER_STATUS)) {
    // starts the task in the background
    const pollBityOrderStatusTask = yield fork(pollBityOrderStatus);
    // wait for the user to get to point where refresh is no longer needed
    yield take(swapTypes.SwapActions.STOP_POLL_BITY_ORDER_STATUS);
    // cancel the background task
    // this will cause the forked loadBityRates task to jump into its finally block
    yield cancel(pollBityOrderStatusTask);
  }
}

export function* pollShapeshiftOrderStatusSaga(): SagaIterator {
  while (yield take(swapTypes.SwapActions.START_POLL_SHAPESHIFT_ORDER_STATUS)) {
    const pollShapeshiftOrderStatusTask = yield fork(pollShapeshiftOrderStatus);
    yield take(swapTypes.SwapActions.STOP_POLL_SHAPESHIFT_ORDER_STATUS);
    yield cancel(pollShapeshiftOrderStatusTask);
  }
}

export function* postBityOrderCreate(
  action: swapTypes.BityOrderCreateRequestedSwapAction
): SagaIterator {
  const payload = action.payload;
  try {
    yield put(swapActions.stopLoadBityRatesSwap());
    const order = yield call(
      postOrder,
      payload.amount,
      payload.destinationAddress,
      payload.mode,
      payload.pair
    );
    if (order.error) {
      // TODO - handle better / like existing site?
      yield put(
        notificationsActions.showNotification('danger', `Bity Error: ${order.msg}`, TEN_SECONDS)
      );
      yield put(swapActions.bityOrderCreateFailedSwap());
    } else {
      yield put(swapActions.bityOrderCreateSucceededSwap(order.data));
      yield put(swapActions.changeStepSwap(3));
      // start countdown
      yield put(swapActions.startOrderTimerSwap());
      // start bity order status polling
      yield put(swapActions.startPollBityOrderStatus());
    }
  } catch (e) {
    const message =
      'Connection Error. Please check the developer console for more details and/or contact support';
    console.error(e);
    yield put(notificationsActions.showNotification('danger', message, TEN_SECONDS));
    yield put(swapActions.bityOrderCreateFailedSwap());
  }
}

export function* postShapeshiftOrderCreate(
  action: swapTypes.ShapeshiftOrderCreateRequestedSwapAction
): SagaIterator {
  const payload = action.payload;
  try {
    yield put(swapActions.stopLoadShapeshiftRatesSwap());
    const order = yield apply(shapeshift, shapeshift.sendAmount, [
      payload.withdrawal,
      payload.originKind,
      payload.destinationKind,
      payload.destinationAmount
    ]);
    if (order.error) {
      yield put(
        notificationsActions.showNotification(
          'danger',
          `Shapeshift Error: ${order.error}`,
          TEN_SECONDS
        )
      );
      yield put(swapActions.shapeshiftOrderCreateFailedSwap());
    } else {
      yield put(swapActions.shapeshiftOrderCreateSucceededSwap(order.success));
      yield put(swapActions.changeStepSwap(3));
      // start countdown
      yield put(swapActions.startOrderTimerSwap());
      // start shapeshift order status polling
      yield put(swapActions.startPollShapeshiftOrderStatus());
    }
  } catch (e) {
    if (e && e.message) {
      yield put(notificationsActions.showNotification('danger', e.message, TEN_SECONDS));
    } else {
      const message =
        'Connection Error. Please check the developer console for more details and/or contact support';
      console.error(e);
      yield put(notificationsActions.showNotification('danger', message, TEN_SECONDS));
    }
    yield put(swapActions.shapeshiftOrderCreateFailedSwap());
  }
}

export function* restartSwapSaga() {
  yield put(walletActions.resetWallet());
  yield put(swapActions.stopPollShapeshiftOrderStatus());
  yield put(swapActions.stopPollBityOrderStatus());
  yield put(swapActions.loadShapeshiftRatesRequestedSwap());
}

export function* bityOrderTimeRemaining(): SagaIterator {
  while (true) {
    let hasShownNotification = false;
    while (true) {
      yield call(delay, ONE_SECOND);
      const swap = yield select(swapSelectors.getSwap);
      const createdTimeStampMoment = moment(swap.orderTimestampCreatedISOString);
      const validUntil = moment(createdTimeStampMoment).add(swap.validFor, 's');
      const now = moment();
      if (validUntil.isAfter(now)) {
        const duration = moment.duration(validUntil.diff(now));
        const seconds = duration.asSeconds();
        yield put(swapActions.orderTimeSwap(parseInt(seconds.toString(), 10)));

        switch (swap.bityOrderStatus) {
          case 'CANC':
            yield put(swapActions.stopPollBityOrderStatus());
            yield put(swapActions.stopLoadBityRatesSwap());
            yield put(swapActions.stopOrderTimerSwap());
            if (!hasShownNotification) {
              hasShownNotification = true;
              yield put(
                notificationsActions.showNotification('danger', ORDER_TIMEOUT_MESSAGE, Infinity)
              );
            }
            break;
          case 'FILL':
            yield put(swapActions.stopPollBityOrderStatus());
            yield put(swapActions.stopLoadBityRatesSwap());
            yield put(swapActions.stopOrderTimerSwap());
            break;
        }
      } else {
        switch (swap.bityOrderStatus) {
          case 'OPEN':
            yield put(swapActions.orderTimeSwap(0));
            yield put(swapActions.stopPollBityOrderStatus());
            yield put(swapActions.stopLoadBityRatesSwap());
            if (!hasShownNotification) {
              hasShownNotification = true;
              yield put(
                notificationsActions.showNotification('danger', ORDER_TIMEOUT_MESSAGE, Infinity)
              );
            }
            break;
          case 'CANC':
            yield put(swapActions.stopPollBityOrderStatus());
            yield put(swapActions.stopLoadBityRatesSwap());
            if (!hasShownNotification) {
              hasShownNotification = true;
              yield put(
                notificationsActions.showNotification('danger', ORDER_TIMEOUT_MESSAGE, Infinity)
              );
            }
            break;
          case 'RCVE':
            if (!hasShownNotification) {
              hasShownNotification = true;
              yield put(
                notificationsActions.showNotification('warning', ORDER_TIMEOUT_MESSAGE, Infinity)
              );
            }
            break;
          case 'FILL':
            yield put(swapActions.stopPollBityOrderStatus());
            yield put(swapActions.stopLoadBityRatesSwap());
            yield put(swapActions.stopOrderTimerSwap());
            break;
        }
      }
    }
  }
}

export function* shapeshiftOrderTimeRemaining(): SagaIterator {
  while (true) {
    let hasShownNotification = false;
    while (true) {
      yield call(delay, ONE_SECOND);
      const swap = yield select(swapSelectors.getSwap);
      const createdTimeStampMoment = moment(swap.orderTimestampCreatedISOString);
      const validUntil = moment(createdTimeStampMoment).add(swap.validFor, 's');
      const now = moment();
      if (validUntil.isAfter(now)) {
        const duration = moment.duration(validUntil.diff(now));
        const seconds = duration.asSeconds();
        yield put(swapActions.orderTimeSwap(parseInt(seconds.toString(), 10)));
        switch (swap.shapeshiftOrderStatus) {
          case 'failed':
            yield put(swapActions.stopPollShapeshiftOrderStatus());
            yield put(swapActions.stopLoadShapeshiftRatesSwap());
            yield put(swapActions.stopOrderTimerSwap());
            if (!hasShownNotification) {
              hasShownNotification = true;
              yield put(
                notificationsActions.showNotification('danger', ORDER_TIMEOUT_MESSAGE, Infinity)
              );
            }
            break;
          case 'received':
            yield put(swapActions.stopOrderTimerSwap());
            break;
          case 'complete':
            yield put(swapActions.stopPollShapeshiftOrderStatus());
            yield put(swapActions.stopLoadShapeshiftRatesSwap());
            yield put(swapActions.stopOrderTimerSwap());
            break;
        }
      } else {
        switch (swap.shapeshiftOrderStatus) {
          case 'no_deposits':
            if (!hasShownNotification) {
              hasShownNotification = true;
              yield put(swapActions.orderTimeSwap(0));
              yield put(swapActions.stopPollShapeshiftOrderStatus());
              yield put(swapActions.stopLoadShapeshiftRatesSwap());
              yield put(
                notificationsActions.showNotification('danger', ORDER_TIMEOUT_MESSAGE, Infinity)
              );
            }
            break;
          case 'failed':
            if (!hasShownNotification) {
              hasShownNotification = true;
              yield put(swapActions.stopPollShapeshiftOrderStatus());
              yield put(swapActions.stopLoadShapeshiftRatesSwap());
              yield put(
                notificationsActions.showNotification('danger', ORDER_TIMEOUT_MESSAGE, Infinity)
              );
            }
            break;
          case 'received':
            if (!hasShownNotification) {
              hasShownNotification = true;
              yield put(
                notificationsActions.showNotification('warning', ORDER_RECEIVED_MESSAGE, Infinity)
              );
            }
            break;
          case 'complete':
            yield put(swapActions.stopPollShapeshiftOrderStatus());
            yield put(swapActions.stopLoadShapeshiftRatesSwap());
            yield put(swapActions.stopOrderTimerSwap());
            break;
        }
      }
    }
  }
}

export function* handleOrderTimeRemaining(): SagaIterator {
  const swap = yield select(swapSelectors.getSwap);
  let orderTimeRemainingTask;
  if (swap.provider === 'shapeshift') {
    orderTimeRemainingTask = yield fork(shapeshiftOrderTimeRemaining);
  } else {
    orderTimeRemainingTask = yield fork(bityOrderTimeRemaining);
  }
  yield take(swapTypes.SwapActions.ORDER_STOP_TIMER);
  yield cancel(orderTimeRemainingTask);
}

export function* swapOrdersSaga(): SagaIterator {
  yield fork(handleOrderTimeRemaining);
  yield fork(pollShapeshiftOrderStatusSaga);
  yield fork(pollBityOrderStatusSaga);
  yield takeEvery(swapTypes.SwapActions.BITY_ORDER_CREATE_REQUESTED, postBityOrderCreate);
  yield takeEvery(
    swapTypes.SwapActions.SHAPESHIFT_ORDER_CREATE_REQUESTED,
    postShapeshiftOrderCreate
  );
  yield takeEvery(swapTypes.SwapActions.ORDER_START_TIMER, handleOrderTimeRemaining);
  yield takeEvery(swapTypes.SwapActions.RESTART, restartSwapSaga);
}
//#endregion Orders

//#region Rates
export const SHAPESHIFT_TIMEOUT = 10000;
export const POLLING_CYCLE = 30000;

export function* loadBityRates(): SagaIterator {
  while (true) {
    try {
      const data = yield call(getAllRates);
      yield put(swapActions.loadBityRatesSucceededSwap(data));
    } catch (error) {
      const hasNotified = yield select(swapSelectors.getHasNotifiedRatesFailure);
      if (!hasNotified) {
        console.error('Failed to load rates from Bity:', error);
        yield put(notificationsActions.showNotification('danger', error.message));
      }
      yield put(swapActions.loadBityRatesFailedSwap());
    }
    yield call(delay, POLLING_CYCLE);
  }
}

export function* handleBityRates(): SagaIterator {
  const loadBityRatesTask = yield fork(loadBityRates);
  yield take(swapTypes.SwapActions.STOP_LOAD_BITY_RATES);
  yield cancel(loadBityRatesTask);
}

export function* loadShapeshiftRates(): SagaIterator {
  while (true) {
    try {
      // Race b/w api call and timeout
      // getShapeShiftRates should be an api call that accepts a whitelisted arr of symbols
      const { tokens } = yield race({
        tokens: call(shapeshift.getAllRates),
        timeout: call(delay, SHAPESHIFT_TIMEOUT)
      });
      // If tokens exist, put it into the redux state, otherwise switch to bity.
      if (tokens) {
        yield put(swapActions.loadShapeshiftRatesSucceededSwap(tokens));
      } else {
        throw new Error('ShapeShift rates request timed out.');
      }
    } catch (error) {
      const hasNotified = yield select(swapSelectors.getHasNotifiedRatesFailure);
      if (!hasNotified) {
        console.error('Failed to fetch rates from shapeshift:', error);
        yield put(
          notificationsActions.showNotification(
            'danger',
            'Failed to load swap rates from ShapeShift, please try again later'
          )
        );
      }
      yield put(swapActions.loadShapeshiftRatesFailedSwap());
    }
    yield call(delay, POLLING_CYCLE);
  }
}

export function* handleShapeshiftRates(): SagaIterator {
  const loadShapeshiftRatesTask = yield fork(loadShapeshiftRates);
  yield take(swapTypes.SwapActions.STOP_LOAD_SHAPESHIFT_RATES);
  yield cancel(loadShapeshiftRatesTask);
}

export function* swapProvider(action: swapTypes.ChangeProviderSwapAcion): SagaIterator {
  const swap = yield select(swapSelectors.getSwap);
  if (swap.provider !== action.payload) {
    yield put(swapActions.changeSwapProvider(action.payload));
  }
}

export function* swapRatesSaga(): SagaIterator {
  yield takeLatest(swapTypes.SwapActions.LOAD_BITY_RATES_REQUESTED, handleBityRates);
  yield takeLatest(swapTypes.SwapActions.LOAD_SHAPESHIFT_RATES_REQUESTED, handleShapeshiftRates);
  yield takeLatest(swapTypes.SwapActions.CHANGE_PROVIDER, swapProvider);
}
//#endregion Rates

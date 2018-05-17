import { connect } from 'react-redux';

import { AppState } from 'redux/reducers';
import { getWalletType } from 'redux/wallet/selectors';
import { getSchedulingTransaction } from 'redux/schedule/selectors';
import {
  getSerializedTransaction,
  isNetworkRequestPending,
  isValidGasPrice,
  isValidGasLimit,
  getSignedTx,
  getWeb3Tx
} from 'redux/transaction/selectors';
import { SendButtonFactoryClass } from 'components/SendButtonFactory';

const mapStateToProps = (state: AppState) => {
  return {
    walletType: getWalletType(state),
    serializedTransaction: getSerializedTransaction(state),
    ...getSchedulingTransaction(state),
    networkRequestPending: isNetworkRequestPending(state),
    validGasPrice: isValidGasPrice(state),
    validGasLimit: isValidGasLimit(state),
    signedTx: !!getSignedTx(state) || !!getWeb3Tx(state)
  };
};

export const SendScheduleTransactionButtonFactory = connect(mapStateToProps)(
  SendButtonFactoryClass
);

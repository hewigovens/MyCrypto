import React, { Component } from 'react';
import { connect } from 'react-redux';

import { AppState } from 'redux/reducers';
import {
  getCurrentWindowStart,
  ICurrentWindowStart,
  isValidCurrentWindowStart
} from 'redux/schedule/selectors';
import { getResolvingDomain } from 'redux/ens/selectors';
import { Query } from 'components/renderCbs';
import { CallbackProps } from './WindowStartFieldFactory';

interface StateProps {
  currentWindowStart: ICurrentWindowStart;
  isValid: boolean;
  isResolving: boolean;
}

interface OwnProps {
  onChange(ev: React.FormEvent<HTMLInputElement>): void;
  withProps(props: CallbackProps): React.ReactElement<any> | null;
}

type Props = OwnProps & StateProps;

class WindowStartInputFactoryClass extends Component<Props> {
  public render() {
    const { currentWindowStart, onChange, isValid, withProps } = this.props;

    return (
      <Query
        params={['readOnly']}
        withQuery={({ readOnly }) =>
          withProps({
            currentWindowStart,
            isValid,
            onChange,
            readOnly: !!readOnly || this.props.isResolving
          })
        }
      />
    );
  }
}

export const WindowStartInputFactory = connect((state: AppState) => ({
  currentWindowStart: getCurrentWindowStart(state),
  isResolving: getResolvingDomain(state),
  isValid: isValidCurrentWindowStart(state)
}))(WindowStartInputFactoryClass);

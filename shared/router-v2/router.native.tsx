import * as Constants from '../constants/router2'
import * as Kbfs from '../fs/common'
import * as Kb from '../common-adapters/mobile.native'
import * as React from 'react'
import * as Shared from './router.shared'
import * as Shim from './shim.native'
import * as Stack from 'react-navigation-stack'
import * as Styles from '../styles'
import * as Tabs from '../constants/tabs'
import * as FsConstants from '../constants/fs'
import * as Container from '../util/container'
import shallowEqual from 'shallowequal'
import logger from '../logger'
import {IconType} from '../common-adapters/icon.constants-gen'
import {LeftAction} from '../common-adapters/header-hoc'
import {Props} from './router'
import {connect} from '../util/container'
import {createAppContainer} from '@react-navigation/native'
import {createBottomTabNavigator} from 'react-navigation-tabs'
import {createSwitchNavigator, StackActions} from '@react-navigation/core'
import debounce from 'lodash/debounce'
import {modalRoutes, routes, loggedOutRoutes, tabRoots} from './routes'
import {useScreens} from 'react-native-screens'
import {getPersistenceFunctions} from './persist.native'
import Loading from '../login/loading'

const {createStackNavigator} = Stack

// turn on screens. lint thinks this is a hook, but its not
// eslint-disable-next-line
useScreens()

// Options used by default on all navigators
// For info on what is passed to what see here: https://github.com/react-navigation/stack/blob/478c354248f2aedfc304a1c4b479c3df359d3868/src/views/Header/Header.js
const defaultNavigationOptions: any = {
  backBehavior: 'none',
  header: null,
  headerLeft: hp =>
    hp.scene.index === 0 ? null : (
      <LeftAction
        badgeNumber={0}
        leftAction="back"
        onLeftAction={hp.onPress} // react navigation makes sure this onPress can only happen once
        customIconColor={hp.tintColor}
      />
    ),
  headerStyle: {
    get backgroundColor() {
      return Styles.globalColors.fastBlank
    },
    get borderBottomColor() {
      return Styles.globalColors.black_10
    },
    borderBottomWidth: 1,
    borderStyle: 'solid',
    elevation: undefined, // since we use screen on android turn off drop shadow
  },
  headerTitle: hp => (
    <Kb.Text type="BodyBig" style={styles.headerTitle} lineClamp={1}>
      {hp.children}
    </Kb.Text>
  ),
}
// workaround for https://github.com/react-navigation/react-navigation/issues/4872 else android will eat clicks
const headerMode = Styles.isAndroid ? 'screen' : 'float'

const tabs = Shared.mobileTabs

type TabData = {
  icon: IconType
  label: string
}
const data: {[key: string]: TabData} = {
  [Tabs.chatTab]: {icon: 'iconfont-nav-2-chat', label: 'Chat'},
  [Tabs.fsTab]: {icon: 'iconfont-nav-2-files', label: 'Files'},
  [Tabs.teamsTab]: {icon: 'iconfont-nav-2-teams', label: 'Teams'},
  [Tabs.peopleTab]: {icon: 'iconfont-nav-2-people', label: 'People'},
  [Tabs.settingsTab]: {icon: 'iconfont-nav-2-hamburger', label: 'More'},
  [Tabs.walletsTab]: {icon: 'iconfont-nav-2-wallets', label: 'Wallets'},
}

const FilesTabBadge = () => {
  const uploadIcon = FsConstants.getUploadIconForFilesTab(Container.useSelector(state => state.fs.badge))
  return uploadIcon ? <Kbfs.UploadIcon uploadIcon={uploadIcon} style={styles.fsBadgeIconUpload} /> : null
}

const TabBarIcon = ({badgeNumber, focused, routeName}) => (
  <Kb.NativeView style={tabStyles.container}>
    <Kb.Icon
      type={data[routeName].icon}
      fontSize={32}
      style={tabStyles.tab}
      color={focused ? Styles.globalColors.whiteOrWhite : Styles.globalColors.blueDarkerOrBlack}
    />
    {!!badgeNumber && <Kb.Badge badgeNumber={badgeNumber} badgeStyle={tabStyles.badge} />}
    {routeName === Tabs.fsTab && <FilesTabBadge />}
  </Kb.NativeView>
)

const settingsTabChildren: Array<Tabs.Tab> = [Tabs.gitTab, Tabs.devicesTab, Tabs.walletsTab, Tabs.settingsTab]

type OwnProps = {focused: boolean; routeName: Tabs.Tab}
const ConnectedTabBarIcon = connect(
  (state, {routeName}: OwnProps) => {
    const onSettings = routeName === Tabs.settingsTab
    const badgeNumber = (onSettings ? settingsTabChildren : [routeName]).reduce(
      (res, tab) => res + (state.notifications.navBadges.get(tab) || 0),
      // notifications gets badged on native if there's no push, special case
      onSettings && !state.push.hasPermissions ? 1 : 0
    )
    return {badgeNumber}
  },
  () => ({}),
  (s, _, o: OwnProps) => ({
    badgeNumber: s.badgeNumber,
    focused: o.focused,
    routeName: o.routeName,
  })
)(TabBarIcon)

// The default container has some `hitSlop` set which messes up the clickable
// area
const TabBarIconContainer = props => (
  <Kb.NativeTouchableWithoutFeedback style={props.style} onPress={props.onPress}>
    <Kb.Box children={props.children} style={props.style} />
  </Kb.NativeTouchableWithoutFeedback>
)

// globalColors automatically respects dark mode pref
const getBg = () => Styles.globalColors.white

const BlankScreen = () => null

const VanillaTabNavigator = createBottomTabNavigator(
  tabs.reduce(
    (map, tab) => {
      const Stack = createStackNavigator(Shim.shim(routes), {
        bgOnlyDuringTransition: Styles.isAndroid ? getBg : undefined,
        cardStyle: Styles.isAndroid ? {backgroundColor: 'rgba(0,0,0,0)'} : undefined,
        defaultNavigationOptions,
        headerMode,
        initialRouteKey: tabRoots[tab],
        initialRouteName: tabRoots[tab],
        initialRouteParams: undefined,
        transitionConfig: () => ({
          containerStyle: {
            get backgroundColor() {
              return Styles.globalColors.white
            },
          },
          transitionSpec: {
            // the 'accurate' ios one is very slow to stop so going back leads to a missed taps
            duration: 250,
            easing: Kb.NativeEasing.bezier(0.2833, 0.99, 0.31833, 0.99),
            timing: Kb.NativeAnimated.timing,
          },
        }),
      })
      class CustomStackNavigator extends React.Component<any> {
        static router = {
          ...Stack.router,
          getStateForAction: (action, lastState) => {
            // disallow dupe pushes or replaces. We have logic for this in oldActionToNewActions but it can be
            // racy, this should work no matter what as this is effectively the reducer for the state
            const nextState = Stack.router.getStateForAction(action, lastState)

            const visiblePath = Constants._getStackPathHelper([], nextState)
            const last = visiblePath?.[visiblePath.length - 1]
            const nextLast = visiblePath?.[visiblePath.length - 2]

            // last two are dupes?
            if (last?.routeName === nextLast?.routeName && shallowEqual(last?.params, nextLast?.params)) {
              // just pop it
              return Stack.router.getStateForAction(StackActions.pop({}), nextState)
            }

            return nextState
          },
        }

        render() {
          const {navigation} = this.props
          return <Stack navigation={navigation} />
        }
      }
      map[tab] = CustomStackNavigator
      return map
    },
    // Start with a blank screen w/o a tab icon so we dont' render the people tab on start always
    {blank: {screen: BlankScreen}}
  ),
  {
    backBehavior: 'none',
    defaultNavigationOptions: ({navigation}) => {
      const routeName = navigation.state.index && navigation.state.routes[navigation.state.index].routeName
      const tabBarVisible = routeName !== 'chatConversation'

      return {
        tabBarButtonComponent: navigation.state.routeName === 'blank' ? BlankScreen : TabBarIconContainer,
        tabBarIcon: ({focused}) => (
          <ConnectedTabBarIcon focused={focused} routeName={navigation.state.routeName as Tabs.Tab} />
        ),
        tabBarLabel: ({focused}) =>
          navigation.state.routeName === 'blank' ? (
            <></>
          ) : (
            <Kb.Text
              // @ts-ignore expecting a literal color, not a getter
              style={{
                color: focused ? Styles.globalColors.whiteOrWhite : Styles.globalColors.blueDarkerOrBlack,
                marginLeft: Styles.globalMargins.medium,
              }}
              type="BodyBig"
            >
              {data[navigation.state.routeName].label}
            </Kb.Text>
          ),
        tabBarVisible,
      }
    },
    order: ['blank', ...tabs],
    tabBarOptions: {
      get activeBackgroundColor() {
        return Styles.globalColors.blueDarkOrGreyDarkest
      },
      get inactiveBackgroundColor() {
        return Styles.globalColors.blueDarkOrGreyDarkest
      },
      // else keyboard avoiding is racy on ios and won't work correctly
      keyboardHidesTabBar: Styles.isAndroid,
      showLabel: Styles.isTablet,
      get style() {
        return {backgroundColor: Styles.globalColors.blueDarkOrGreyDarkest}
      },
    },
  }
)

class UnconnectedTabNavigator extends React.PureComponent<any> {
  static router = VanillaTabNavigator.router
  render() {
    const {navigation, isDarkMode} = this.props
    return <VanillaTabNavigator navigation={navigation} key={isDarkMode ? 'dark' : 'light'} />
  }
}

const TabNavigator = Container.connect(
  () => ({isDarkMode: Styles.isDarkMode()}),
  undefined,
  (s, _, o: any) => ({
    ...s,
    ...o,
  })
)(UnconnectedTabNavigator)

const tabStyles = Styles.styleSheetCreate(
  () =>
    ({
      badge: Styles.platformStyles({
        common: {
          position: 'absolute',
          right: 8,
          top: 3,
        },
        isTablet: {
          marginRight: Styles.globalMargins.tiny,
        },
      }),
      container: {
        justifyContent: 'center',
      },
      tab: Styles.platformStyles({
        common: {
          paddingBottom: 6,
          paddingLeft: 16,
          paddingRight: 16,
          paddingTop: 6,
        },
        isTablet: {
          width: '100%',
        },
      }),
    } as const)
)

const LoggedInStackNavigator = createStackNavigator(
  {
    Main: TabNavigator,
    ...Shim.shim(modalRoutes),
  },
  {
    bgOnlyDuringTransition: Styles.isAndroid ? getBg : undefined,
    cardStyle: Styles.isAndroid ? {backgroundColor: 'rgba(0,0,0,0)'} : undefined,
    headerMode: 'none',
    mode: 'modal',
  }
)

const LoggedOutStackNavigator = createStackNavigator(
  {...Shim.shim(loggedOutRoutes)},
  {
    defaultNavigationOptions: {
      ...defaultNavigationOptions,
      // show the header
      header: undefined,
    },
    headerMode,
    initialRouteName: 'login',
    initialRouteParams: undefined,
  }
)

const SimpleLoading = () => (
  <Kb.Box2
    direction="vertical"
    fullHeight={true}
    fullWidth={true}
    style={{backgroundColor: Styles.globalColors.white}}
  >
    <Loading allowFeedback={false} failed="" status="" onRetry={null} onFeedback={null} />
  </Kb.Box2>
)

const RootStackNavigator = createSwitchNavigator(
  {
    loading: {screen: SimpleLoading},
    loggedIn: LoggedInStackNavigator,
    loggedOut: LoggedOutStackNavigator,
  },
  {initialRouteName: 'loading'}
)

const AppContainer = createAppContainer(RootStackNavigator)

class RNApp extends React.PureComponent<Props> {
  private nav: any = null

  // TODO remove this eventually, just so we can handle the old style actions
  dispatchOldAction = (old: any) => {
    const nav = this.nav
    if (!nav) {
      throw new Error('Missing nav?')
    }

    const actions = Shared.oldActionToNewActions(old, nav._navigation) || []
    try {
      actions.forEach(a => nav.dispatch(a))
    } catch (e) {
      logger.error('Nav error', e)
    }
  }

  dispatch = (a: any) => {
    const nav = this.nav
    if (!nav) {
      throw new Error('Missing nav?')
    }
    nav.dispatch(a)
  }

  // debounce this so we don't persist a route that can crash and then keep them in some crash loop
  private persistRoute = debounce(() => {
    this.props.persistRoute(Constants.getVisiblePath())
  }, 3000)

  getNavState = () => {
    const n = this.nav
    return (n && n.state && n.state.nav) || null
  }

  private setNav = (n: any) => {
    this.nav = n
  }

  private onNavigationStateChange = () => {
    this.persistRoute()
  }

  // hmr messes up startup, so only set this after its rendered once
  private hmrProps = () => {
    if (this.nav) {
      return getPersistenceFunctions()
    } else {
      return {}
    }
  }

  render() {
    return (
      <AppContainer
        ref={this.setNav}
        onNavigationStateChange={this.onNavigationStateChange}
        {...this.hmrProps()}
      />
    )
  }
}

const styles = Styles.styleSheetCreate(() => ({
  fsBadgeIconUpload: {
    bottom: Styles.globalMargins.tiny,
    height: Styles.globalMargins.small,
    position: 'absolute',
    right: Styles.globalMargins.small,
    width: Styles.globalMargins.small,
  },
  headerTitle: {color: Styles.globalColors.black},
  keyboard: {
    flexGrow: 1,
    position: 'relative',
  },
}))

export default RNApp

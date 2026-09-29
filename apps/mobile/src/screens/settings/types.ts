/**
 * Routes of the Settings sheet's own stack.
 *
 * Settings is presented as a sheet over the root stack and pushes its detail
 * screens inside that sheet, so it has a param list separate from
 * `RootStackParamList`. Detail routes carry ids, never the objects themselves:
 * each detail screen refetches on focus, which keeps params serialisable and
 * the data current after an edit.
 */

import type { NativeStackScreenProps } from "@react-navigation/native-stack";

export type SettingsStackParamList = {
  SettingsHome: undefined;
  Providers: undefined;
  Provider: { providerId: string };
  Plugins: undefined;
  Plugin: { pluginId: string };
  Runners: undefined;
  Allowlist: undefined;
  Connection: undefined;
};

export type SettingsScreenProps<T extends keyof SettingsStackParamList> = NativeStackScreenProps<
  SettingsStackParamList,
  T
>;

import { registerRootComponent } from "expo";

import App from "./App";

// registerRootComponent sets up the environment for both Expo Go and a native
// build, and calls AppRegistry.registerComponent("main", () => App) under the
// hood. It is the entry point named by `main` in package.json.
registerRootComponent(App);

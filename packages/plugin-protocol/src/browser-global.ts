import { applyPluginTheme, connectInProgress, InProgressClient } from "./client.js";
import { PLUGIN_API_VERSION } from "./schemas.js";

Object.assign(globalThis, {
  InProgressProtocol: {
    apiVersion: PLUGIN_API_VERSION,
    applyPluginTheme,
    connectInProgress,
    InProgressClient,
  },
});

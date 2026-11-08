// @ts-check
/** @param {import("expo/config").ConfigContext} param0 */
module.exports = ({ config }) => {
  const oauthConfig = config.extra?.oauth ?? {};

  return {
    ...config,
    extra: {
      ...config.extra,
      oauth: {
        ...oauthConfig,
        webGoogleClientId:
          process.env.GOOGLE_OAUTH_CLIENT_ID_WEB ??
          oauthConfig.webGoogleClientId ??
          "",
        webRedirectUri:
          process.env.GOOGLE_OAUTH_REDIRECT_URI ??
          oauthConfig.webRedirectUri ??
          "https://involvex-sync-oauth.involvex.workers.dev/oauth",
        webTokenExchangeUrl:
          process.env.GOOGLE_WEB_TOKEN_EXCHANGE_URL ??
          oauthConfig.webTokenExchangeUrl ??
          "https://involvex-sync-oauth.involvex.workers.dev/token",
      },
    },
  };
};

const path = require('node:path');
const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');
module.exports = {
  hooks: {preMake: async () => {
    // The vendor selector can be blocked by npm's lifecycle policy. Select only this build's x64 tools.
    const fs=require('node:fs');
    const vendor=path.join(path.dirname(require.resolve('electron-winstaller/package.json')),'vendor');
    for(const extension of ['exe','dll'])fs.copyFileSync(path.join(vendor,`7z-x64.${extension}`),path.join(vendor,`7z.${extension}`));
  }},
  packagerConfig: {
    asar: true,
    executableName: 'RainBot',
    icon: path.join(__dirname, '.stage/ui/rainbot.ico'),
    extraResource: ['backend','ui','node'].map(name => path.join(__dirname,'.stage',name)),
    ignore: [/^\/\.stage(?:\/|$)/, /^\/out(?:\/|$)/, /^\/forge\.config\.cjs$/, /^\/smoke\.mjs$/, /^\/package-lock\.json$/],
  },
  rebuildConfig: {},
  makers: [{name:'@electron-forge/maker-squirrel',config:{name:'RainBot',setupExe:'RainBotSetup.exe',
    ...(process.env.RAINBOT_SIGN_CERT ? {certificateFile:process.env.RAINBOT_SIGN_CERT,certificatePassword:process.env.RAINBOT_SIGN_PASSWORD} : {}),
  }}],
  plugins: [new FusesPlugin({version:FuseVersion.V1,
    [FuseV1Options.RunAsNode]:false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]:false,
    [FuseV1Options.EnableNodeCliInspectArguments]:false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]:true,
    [FuseV1Options.OnlyLoadAppFromAsar]:true,
  })],
};

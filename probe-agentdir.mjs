import { getAgentDir, ENV_AGENT_DIR, APP_NAME, CONFIG_DIR_NAME } from "file:///C:/Users/Ivan/.npm-global/node_modules/@earendil-works/pi-coding-agent/dist/config.js";
console.log("APP_NAME:", APP_NAME);
console.log("CONFIG_DIR_NAME:", CONFIG_DIR_NAME);
console.log("ENV_AGENT_DIR:", ENV_AGENT_DIR);
console.log("PI in env:", process.env.PI_CODING_AGENT_DIR || "<unset>");
console.log("GSD in env:", process.env.GSD_CODING_AGENT_DIR || "<unset>");
console.log("getAgentDir():", getAgentDir());

import { Config } from "@remotion/cli/config";
// PNG frames are REQUIRED for the alpha channel to survive into ProRes 4444.
Config.setVideoImageFormat("png");

import { requirements } from "./manifest.ts";
import { definition } from "../../definition.ts";
import { defineModule } from "../../../../core/src/module.ts";
import { videoTool } from "./tool.ts";
export default defineModule(definition, requirements, () => ({ tool: videoTool() }));

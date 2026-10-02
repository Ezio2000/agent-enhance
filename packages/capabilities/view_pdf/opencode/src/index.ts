import { requirements } from "./manifest.ts";
import { definition } from "../../definition.ts";
import { defineModule } from "../../../../core/src/module.ts";
import { pdfTool } from "./tool.ts";
export default defineModule(definition, requirements, () => ({ tool: pdfTool() }));

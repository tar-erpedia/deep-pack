"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const program_1 = __importDefault(require("./program"));
(async () => {
    const program = new program_1.default();
    await program.exec();
})();
//# sourceMappingURL=deep-pack.js.map
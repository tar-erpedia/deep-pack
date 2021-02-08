#!/usr/bin/env node
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
define("deep-pack", ["require", "exports", "chalk", "clear", "figlet"], function (require, exports, chalk_1, clear_1, figlet_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    chalk_1 = __importDefault(chalk_1);
    clear_1 = __importDefault(clear_1);
    figlet_1 = __importDefault(figlet_1);
    clear_1.default();
    console.log(chalk_1.default.blue(figlet_1.default.textSync('deep-pack-cli', { horizontalLayout: 'full' })));
});

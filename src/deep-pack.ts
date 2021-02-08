#!/usr/bin/env node
import chalk from "chalk";
import clear from "clear";
import commander from "commander";
import figlet from "figlet";
import path from "path";

clear();
console.log(
  chalk.blue(
    figlet.textSync('deep-pack-cli', { horizontalLayout: 'full' })
  )
);

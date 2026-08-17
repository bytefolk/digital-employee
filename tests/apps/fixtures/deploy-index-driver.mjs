import { deploy } from "../../../apps/cli/deploy/index.js"

const options = JSON.parse(process.argv[2] ?? "{}")
await deploy(options)

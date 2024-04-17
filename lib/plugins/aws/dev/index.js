'use strict';

const path = require('path');
const archiver = require('archiver');
const iot = require('aws-iot-device-sdk');
const chokidar = require('chokidar');
const validate = require('../lib/validate');
const fs = require('fs');
const _ = require('lodash');
const ServerlessError = require('../../../serverless-error');
const LocalLambda = require('./local-lambda');
const chalk = require('chalk');
const util = require('util');
const { progress } = require('@serverless/utils/log');
const mainProgress = progress.get('main');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const logLogo = () => {
  console.log(`Serverless ${chalk.red('ϟ')} Framework`);
};

const logSuccess = (msg) => {
  console.log(`${chalk.green('✔')} ${msg}`);
};

const logFailure = (msg) => {
  console.log(`${chalk.red('✘')} ${msg}`);
};

const logNotice = (msg) => {
  console.log(`${chalk.yellow('ℹ')} ${msg}`);
};

const logAside = (msg) => {
  console.log(`${chalk.dim(msg)}`);
};

const getEventLog = (event) => {
  let eventLog = '';

  // ApiGateway REST
  if (event.requestContext && event.httpMethod) {
    eventLog = `─ ${event.httpMethod} ${event.path}`;
  }

  // ApiGateway HTTP
  if (event.requestContext && event.routeKey) {
    eventLog = `─ ${event.requestContext.http.method} ${event.requestContext.http.path}`;
  }

  // EventBridge
  if (event['detail-type'] !== undefined) {
    eventLog = `─ ${event.source}`;
  }

  // S3
  if (event.Records && event.Records.length === 1 && event.eventSource === 'aws:s3') {
    eventLog = `─ ${event.Records[0].eventSource} ${event.Records[0].eventName} ${event.Records[0].s3.bucket.name}`;
  }

  // SQS
  if (event.Records && event.Records.length === 1 && event.Records[0].eventSource === 'aws:sqs') {
    eventLog = `─ ${event.Records[0].eventSource} ${event.Records[0].eventSourceARN}`;
  }

  // SNS
  if (event.Records && event.Records.length === 1 && event.Records[0].EventSource === 'aws:sns') {
    eventLog = `─ ${event.Records[0].EventSource} ${event.Records[0].Sns.TopicArn}`;
  }

  return eventLog;
};

const logFunctionEventStart = (functionName, event, isVerbose) => {
  const eventLog = getEventLog(event);

  logAside(`→ ${functionName} ${eventLog}`);

  if (isVerbose) {
    logAside(`${util.inspect(event, { showHidden: true, depth: null, colors: true })}`);
  }
};

const logFunctionEventEnd = (functionName, event, response, isVerbose) => {
  const eventLog = getEventLog(event);

  const responseLog = response?.statusCode ? `─ ${response.statusCode}` : '';

  logAside(`← ${functionName} ${eventLog} ${responseLog}`);

  if (isVerbose) {
    logAside(`${util.inspect(response, { showHidden: true, depth: null, colors: true })}`);
  }
};

/**
 * Constructs an instance of the dev mode plugin, setting up initial properties
 * and configuring hooks based on command inputs.
 *
 * @constructor
 * @param {Object} serverless - The serverless instance
 * @param {Object} [options={}] - The options passed to the plugin, with
 * defaults to an empty object if not provided.
 */
class AwsDev {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options || {};
    this.provider = this.serverless.getProvider('aws');
    this.originalFunctionConfigs = {};

    Object.assign(this, validate);

    this.commands = {
      'dev-build': {
        groupName: 'main',
        options: {},
        usage: 'Runs Dev Mode invocation',
        lifecycleEvents: ['build'],
        serviceDependencyMode: 'required',
        hasAwsExtension: true,
        type: 'entrypoint',
      },
    };
    this.hooks = {};
    /**
     * We need to pack and deploy the dev mode shim only when running the dev command.
     * Since hooks are registered for all plugins regardless of the command, we need to
     * make sure we only overwrite the default packaging behavior in the case of dev mode
     */
    if (this.serverless.processedInput.commands.includes('dev')) {
      this.hooks['before:package:createDeploymentArtifacts'] = async () => await this.pack();
    }

    /**
     * I haven't put too much thought into the hooks we want to expose, but this is good enough for now.
     */
    this.hooks['dev:dev'] = async () => await this.dev();
    this.hooks['dev-build:build'] = async () => {};
  }

  /**
   * The main handler for dev mode. Steps include:
   * - Packaging the shim and setting it as the service deployment artifact.
   * - Updating the service to use the shim.
   * - Spawn a deployment, which will deploy the shim.
   * - Restoring the state to what it was before.
   * - Connect to IoT over websockets, and Listening for lambda events.
   *
   * @async
   * @returns {Promise<void>} This method is long running, so it does not return a value.
   */
  async dev() {
    console.log();
    logLogo();
    console.log();

    mainProgress.notice('Starting a Development Session', { isMainEvent: true });

    await sleep(1000);

    // TODO: This should be applied more selectively
    chokidar
      .watch(this.serverless.config.serviceDir, { ignored: /\.serverless/, ignoreInitial: true })
      .on('all', async (event, path) => {
        await this.serverless.pluginManager.spawn('dev-build');
      });

    await this.update();

    this._updateHooks();

    await this.serverless.pluginManager.spawn('deploy');

    // After the initial deployment we should run one dev-build lifecycle
    // to ensure function code is built if a build plugin is being utilized
    await this.serverless.pluginManager.spawn('dev-build');

    await this.restore();

    await this.connect();

    await this.watch();
  }

  /**
   * When using devmode we are not actually building deploymentArtifacts and are instead
   * using devmode specific hooks and plugins so we remove all createDeploymentArtifacts
   * hooks when running dev mode
   */
  _updateHooks() {
    for (const hook of this.serverless.pluginManager.hooks[
      'after:package:createDeploymentArtifacts'
    ] || []) {
      if (hook.pluginName === 'AwsDev') {
        continue;
      }
      hook.hook = async () => {};
    }

    for (const hook of this.serverless.pluginManager.hooks[
      'before:package:createDeploymentArtifacts'
    ] || []) {
      if (hook.pluginName === 'AwsDev') {
        continue;
      }
      hook.hook = async () => {};
    }
  }

  /**
   * Build, bundle and package the dev mode shim responsible for routing events to the local machine..
   *
   * The method performs the following operations:
   * - Generates the path for the zip file based on the service's name and directory.
   * - Bundles and minifies the "shim.js" file using esbuild.
   * - Creates a zip file and writes the bundled "shim.js" contents to it as "index.js".
   * - Sets the modification date of "index.js" to Unix epoch to ensure consistent
   *   zip file hashing for identical contents.
   * - Set the shim package as the deployment artifact for the service, essentially overwriting the original service package.
   *
   * If errors occur during the bundling or zipping process, the method throws a
   * ServerlessError with appropriate messaging to indicate the failure reason.
   *
   * @async
   * @returns {Promise<string>} A promise that resolves with the path to the created
   * zip file upon successful completion of the packaging process.
   * @throws {ServerlessError} Throws an error if bundling the "shim.js" file or
   * creating the zip file fails, with a specific error code for easier debugging.
   */
  async pack() {
    // Save the shim package in .serverless just like the service package
    const zipFilePath = path.join(
      this.serverless.serviceDir,
      '.serverless',
      `${this.serverless.service.service}.zip`
    );

    this.serverless.service.package.artifact = zipFilePath;

    let shimFileContents;
    try {
      /**
       * The shim.min.js file is built when the binary is built
       */
      shimFileContents = await fs.promises.readFile(path.join(__dirname, 'shim.min.js'));
    } catch (e) {
      console.error(e);
      throw new ServerlessError('Failed to build dev mode shim', 'BUILD_SHIM_FAILED');
    }

    try {
      const zip = archiver.create('zip');
      const output = fs.createWriteStream(zipFilePath);

      return new Promise(async (resolve, reject) => {
        output.on('close', () => {
          return resolve(zipFilePath);
        });

        output.on('error', (err) => {
          return reject(err);
        });
        zip.on('error', (err) => {
          return reject(err);
        });

        output.on('open', async () => {
          zip.pipe(output);

          // Add the bundled shim file contents to the zip file
          zip.append(shimFileContents, {
            name: 'index.js', // This is the name expected by the handler. If you change this, you must change the handlers config below.
            date: new Date(0), // necessary to get the same hash when zipping the same content
          });
          zip.finalize();
        });
      });
    } catch (e) {
      console.error(e);
      throw new ServerlessError('Failed to zip dev mode shim', 'ZIP_SHIM_FAILED');
    }
  }

  /**
   * Updates the serverless service configuration with dev mode config needed for the shim to work. Specifically:
   *   1. Update all AWS Lambda functions' IAM roles to allow all IoT actions.
   *   2. Update all AWS Lambad function's handler to 'index.handler' as set in the shim
   *   3. Update all AWS Lambda functions' runtime to 'nodejs20.x' as expected by the shim
   *   4. Update all AWS Lambda functions' environment variables to include the IoT endpoint and a function identifier.
   *
   * This method also backs up the original IAM configuration and function configurations to allow for later restoration.
   *
   * @returns {Promise<void>} A promise that resolves once all configurations have been updated.
   * @throws {Error} Throws an error if retrieving the IoT endpoint fails.
   */
  async update() {
    // Makes sure we don't mutate the original IAM configuration
    this.originalIamConfig = _.clone(this.serverless.service.provider.iam);

    // Makes sure we support the old iam role statements syntax
    const oldIamRoleStatements = _.get(this.serverless.service.provider, 'iamRoleStatements', []);

    // Makes sure we support the new iam role statements syntax
    const newIamRoleStatements = _.get(this.serverless.service.provider, 'iam.role.statements', []);

    // Makes sure we don't overwrite existing IAM configurations
    const iamRoleStatements = [...oldIamRoleStatements, ...newIamRoleStatements];

    iamRoleStatements.push({
      Effect: 'Allow',
      Action: ['iot:*'],
      Resource: '*',
    });

    _.set(this.serverless.service.provider, 'iam.role.statements', iamRoleStatements);

    // The IoT endpoint is fetched and passed to the lambda function as env var to be used by the shim
    const iotEndpoint = await this.getIotEndpoint();
    const serviceName = this.serverless.service.getServiceName();
    const stageName = this.serverless.getProvider('aws').getStage();

    // Update all functions in the service to use the shim
    this.serverless.service.getAllFunctions().forEach((functionName) => {
      const functionConfig = this.serverless.service.getFunction(functionName);

      this.originalFunctionConfigs[functionName] = _.clone(functionConfig);
      this.originalFunctionConfigs[functionName].environment = _.clone(functionConfig.environment);

      // For build plugins we need to make the original handler path available in the functionConfig
      functionConfig.originalHandler = functionConfig.handler;

      functionConfig.handler = 'index.handler';
      functionConfig.runtime = 'nodejs20.x';

      functionConfig.environment = functionConfig.environment || {};

      // We need to set the function identifier so the shim knows which function was invoked
      functionConfig.environment.SLS_IOT_ENDPOINT = iotEndpoint;
      functionConfig.environment.SLS_SERVICE = serviceName;
      functionConfig.environment.SLS_STAGE = stageName;
      functionConfig.environment.SLS_FUNCTION = functionName;
    });
  }

  /**
   * Restores the serverless service configuration to its original state. Specifically:
   *   1. Resets the IAM configuration.
   *   2. Resets all function configurations to their original handler, runtime, and environment variables.
   *
   * @async
   * @returns {Promise<void>} A promise that resolves once all configurations have been successfully restored.
   */
  async restore() {
    this.serverless.service.provider.iam = this.originalIamConfig;

    this.serverless.service.getAllFunctions().forEach((functionName) => {
      const functionConfig = this.serverless.service.getFunction(functionName);

      const { handler, runtime, environment } = this.originalFunctionConfigs[functionName];

      functionConfig.handler = handler;
      functionConfig.environment = environment;
      functionConfig.runtime = this.provider.getRuntime(runtime);
    });
  }

  /**
   * Fetches the IoT endpoint address from the AWS SDK.
   * It is a single unique endpoint across all regions in an AWS account.
   * It is available in the account by default without having to deploy any infra.
   * Both the shim and the CLI use that endpoint to connect to each other.
   *
   * @returns {Promise<string>} A promise that resolves with the IoT endpoint address.
   */
  async getIotEndpoint() {
    const res = await this.provider.request('Iot', 'describeEndpoint', {
      endpointType: 'iot:Data-ATS',
    });

    return res.endpointAddress;
  }

  getTopicId(topicName) {
    const region = this.serverless.getProvider('aws').getRegion();
    const stage = this.serverless.getProvider('aws').getStage();
    const serviceName = this.serverless.service.getServiceName();

    let topicId = `sls/${region}/${serviceName}/${stage}`;

    if (topicName) {
      topicId += `/${topicName}`;
    }

    return topicId;
  }

  /**
   * Parses the dev mode function identifier into an object containing its constituent components.
   *
   * The development mode function identifier is expected to be a string formatted as follows:
   * "sls/regionName/serviceName/stageName/functionName". This method splits the identifier by '/'
   * and extracts the region name, service name, stage name, and function name.
   *
   *
   * @param {string} devModeFunctionId - The development mode function identifier to be parsed.
   * @returns {Object} An object containing the extracted region name, service name, stage name,
   * and function name from the development mode function identifier.
   */
  parseTopicId(topicId) {
    const [_, regionName, serviceName, stageName, functionName] = topicId.split('/');

    return {
      regionName,
      serviceName,
      stageName,
      functionName,
    };
  }

  /**
   * Connects to the IoT endpoint over websockets and listens for lambda events.
   * The method subscribes to all function invocation topics and listens for incoming events.
   * When an event is received, the method invokes the corresponding function locally, waits for the result,
   * and publishes the result back to the IoT endpoint for the lambda function to use as a response to the invocation.
   *
   * @returns {Promise<void>} This is a long-running method, so it does not return a value.
   */
  async connect() {
    const endpoint = await this.getIotEndpoint();

    const device = new iot.device({
      protocol: 'wss',
      host: endpoint,
    });

    device.on('error', (e) => {
      logFailure('Disconnected. Retrying to connect...');
    });

    device.on('connect', () => {
      logSuccess('Connected. Listening for Events...');
      console.log();

      setInterval(() => {
        device.publish(this.getTopicId('_heartbeat'), JSON.stringify({ connected: true }), {
          qos: 1,
        });
      }, 2000);
    });

    // Each function has a seperate topic we need to subscribe to
    const functionNames = this.serverless.service.getAllFunctions();

    for (const functionName of functionNames) {
      device.subscribe(this.getTopicId(`${functionName}/invocation`), {
        qos: 1,
      });
    }

    /**
     * We listen for messages on the function's invocation topic.
     * Messages include the event, environment, and context for the function invocation.
     */
    device.on('message', async (topic, buffer) => {
      /**
       * parse the topicId to get the function name as set in the yaml file
       * so we can get the function configuration
       */
      const { functionName } = this.parseTopicId(topic);

      /**
       * If _heartbeat is set as the function name, this is just
       * the heartbeat message we publish from the local machine
       * to check if the connection is still alive.
       * Just ignore it.
       */
      if (functionName === '_heartbeat') {
        return;
      }

      const { event, environment, context } = JSON.parse(buffer.toString());

      logFunctionEventStart(functionName, event, this.options.detailed);

      const functionConfig = this.serverless.service.getFunction(functionName);
      const runtime = this.provider.getRuntime(functionConfig.runtime);

      // Spawn the Dev Invoke command to build changes with esbuild
      // await this.serverless.pluginManager.spawn('dev-invoke');

      let serviceAbsolutePath = this.serverless.serviceDir;

      // If a build plugin was used then we need to set the serviceAbsolutePath to the build directory
      if (this.serverless.builtFunctions && this.serverless.builtFunctions.has(functionName)) {
        serviceAbsolutePath = path.join(this.serverless.config.serviceDir, '.serverless', 'build');
      }
      /**
       * We create a new instance of the LocalLambda class to invoke the function locally.
       * We need to know what the original runtime of the user function is to run the correct wrapper
       * We also need the handler to know which file to import and which function to call
       * We also set the environment and context to be passed to the function
       */
      const localLambda = new LocalLambda({
        serviceAbsolutePath,
        // serviceAbsolutePath: path.join(this.serverless.config.serviceDir, '.serverless', 'build'),
        handler: functionConfig.handler,
        runtime,
        environment,
      });

      // set the timeout settings to be used by the getRemainingTimeInMillis function
      context.timeout = functionConfig.timeout || 6;

      /**
       * Invoke the function locally and pass the event and context.
       * The context passed does not include context functions like .done, .succeed, .fail,
       * because we can't stream them over WebSockets. Those functions will be added by the wrapper later.
       * This function waits until the function execution is complete and returns the response.
       * The response includes any error that the function threw.
       */
      const response = await localLambda.invoke(event, context);

      logFunctionEventEnd(functionName, event, response.response, this.options.detailed);

      // Publish the result back to the function
      device.publish(this.getTopicId(`${functionName}/response`), JSON.stringify(response), {
        qos: 1,
      });
    });

    /**
     * Exit the process when the user presses Ctrl+C
     */
    process.on('SIGINT', () => {
      console.log();
      logNotice(
        'Don\'t forget to run "serverless deploy" to keep your code deployed in this stage and region'
      );
      process.exit(0);
    });
  }

  async watch() {
    const configFilePath = path.resolve(
      this.serverless.serviceDir,
      this.serverless.configurationFilename
    );

    chokidar.watch(configFilePath).on('change', (event, path) => {
      logNotice(`If you made infrastructure changes, please restart the dev command.`);
    });
  }
}

module.exports = AwsDev;
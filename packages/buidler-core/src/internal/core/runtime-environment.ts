import debug from "debug";

import {
  BuidlerArguments,
  BuidlerRuntimeEnvironment,
  EnvironmentExtender,
  EthereumProvider,
  Network,
  ParamDefinition,
  ResolvedBuidlerConfig,
  RunSuperFunction,
  RunTaskFunction,
  TaskArguments,
  TaskDefinition,
  TasksMap
} from "../../types";
import { lazyObject } from "../util/lazy";

import { BuidlerError } from "./errors";
import { ERRORS } from "./errors-list";
import { createProvider } from "./providers/construction";
import { OverriddenTaskDefinition } from "./tasks/task-definitions";

const log = debug("buidler:core:bre");

export class Environment implements BuidlerRuntimeEnvironment {
  private static readonly _BLACKLISTED_PROPERTIES: string[] = [
    "injectToGlobal",
    "_runTaskDefinition"
  ];

  /**
   * An EIP1193 Ethereum provider.
   */
  public ethereum: EthereumProvider;

  public network: Network;

  private readonly _extenders: EnvironmentExtender[];

  /**
   * Initializes the Buidler Runtime Environment and the given
   * extender functions.
   *
   * @remarks The extenders' execution order is given by the order
   * of the requires in the buidler's config file and its plugins.
   *
   * @param config The buidler's config object.
   * @param buidlerArguments The parsed buidler's arguments.
   * @param tasks A map of tasks.
   * @param extenders A list of extenders.
   */
  constructor(
    public readonly config: ResolvedBuidlerConfig,
    public readonly buidlerArguments: BuidlerArguments,
    public readonly tasks: TasksMap,
    extenders: EnvironmentExtender[] = []
  ) {
    log("Creating BuidlerRuntimeEnvironment");

    const networkName =
      buidlerArguments.network !== undefined
        ? buidlerArguments.network
        : config.defaultNetwork;

    const networkConfig = config.networks[networkName];

    if (networkConfig === undefined) {
      throw new BuidlerError(ERRORS.NETWORK.CONFIG_NOT_FOUND, {
        network: networkName
      });
    }

    const provider = lazyObject(() => {
      log(`Creating provider for network ${networkName}`);
      return createProvider(
        networkName,
        networkConfig,
        config.solc.version,
        config.paths
      );
    });

    this.network = {
      name: networkName,
      config: config.networks[networkName],
      provider
    };

    this.ethereum = provider;
    this._extenders = extenders;

    extenders.forEach(extender => extender(this));
  }

  /**
   * Executes the task with the given name.
   *
   * @param name The task's name.
   * @param taskArguments A map of task's arguments.
   *
   * @throws a BDLR303 if there aren't any defined tasks with the given name.
   * @returns a promise with the task's execution result.
   */
  public readonly run: RunTaskFunction = async (name, taskArguments = {}) => {
    const taskDefinition = this.tasks[name];

    log("Running task %s", name);

    if (taskDefinition === undefined) {
      throw new BuidlerError(ERRORS.ARGUMENTS.UNRECOGNIZED_TASK, {
        task: name
      });
    }

    const parsedTaskArguments = this._parseValidTaskArguments(
      taskDefinition,
      taskArguments
    );

    return this._runTaskDefinition(taskDefinition, parsedTaskArguments);
  };

  /**
   * Injects the properties of `this` (the Buidler Runtime Environment) into the global scope.
   *
   * @param blacklist a list of property names that won't be injected.
   *
   * @returns a function that restores the previous environment.
   */
  public injectToGlobal(
    blacklist: string[] = Environment._BLACKLISTED_PROPERTIES
  ): () => void {
    const globalAsAny = global as any;

    const previousValues: { [name: string]: any } = {};

    for (const [key, value] of Object.entries(this)) {
      if (blacklist.includes(key)) {
        continue;
      }

      previousValues[key] = globalAsAny[key];
      globalAsAny[key] = value;
    }

    return () => {
      for (const [key, _] of Object.entries(this)) {
        if (blacklist.includes(key)) {
          continue;
        }

        globalAsAny[key] = previousValues[key];
      }
    };
  }

  private async _runTaskDefinition(
    taskDefinition: TaskDefinition,
    taskArguments: TaskArguments
  ) {
    let runSuperFunction: any;

    if (taskDefinition instanceof OverriddenTaskDefinition) {
      runSuperFunction = async (
        _taskArguments: TaskArguments = taskArguments
      ) => {
        log("Running %s's super", taskDefinition.name);

        return this._runTaskDefinition(
          taskDefinition.parentTaskDefinition,
          _taskArguments
        );
      };

      runSuperFunction.isDefined = true;
    } else {
      runSuperFunction = async () => {
        throw new BuidlerError(ERRORS.TASK_DEFINITIONS.RUNSUPER_NOT_AVAILABLE, {
          taskName: taskDefinition.name
        });
      };

      runSuperFunction.isDefined = false;
    }

    const runSuper: RunSuperFunction<TaskArguments> = runSuperFunction;

    const globalAsAny = global as any;
    const previousRunSuper: any = globalAsAny.runSuper;
    globalAsAny.runSuper = runSuper;

    const uninjectFromGlobal = this.injectToGlobal();

    try {
      return await taskDefinition.action(taskArguments, this, runSuper);
    } finally {
      uninjectFromGlobal();
      globalAsAny.runSuper = previousRunSuper;
    }
  }

  /**
   * Check that task arguments are within TaskDefinition defined params constraints.
   * Also, populate missing, non-mandatory arguments with default param values (if any).
   *
   * @private
   * @throws BuidlerError if any of the following are true:
   *  > a required argument is missing
   *  > an argument's value's type doesn't match the defined param type
   *
   * @param taskDefinition
   * @param taskArguments
   * @returns parsedTaskArguments
   */
  private _parseValidTaskArguments(
    taskDefinition: TaskDefinition,
    taskArguments: TaskArguments
  ): TaskArguments {
    const { paramDefinitions, positionalParamDefinitions } = taskDefinition;

    const nonPositionalParamDefinitions = Object.values(paramDefinitions);

    // gather all task param definitions
    const allTaskParamDefinitions = [
      ...nonPositionalParamDefinitions,
      ...positionalParamDefinitions
    ];

    // parses an argument according to a ParamDefinition rules.
    const parseArgument = (
      paramDefinition: ParamDefinition<any>,
      argumentValue: any
    ) => {
      const { name, isOptional, defaultValue, type } = paramDefinition;

      if (argumentValue === undefined) {
        if (isOptional) {
          // undefined & optional argument -> return defaultValue
          return defaultValue;
        }

        // undefined & mandatory argument -> error
        throw new BuidlerError(ERRORS.ARGUMENTS.MISSING_TASK_ARGUMENT, {
          param: name
        });
      }

      // arg was present -> validate type
      try {
        type.validate(name, argumentValue);
      } catch (error) {
        // ensure error is instance of BuidlerError, and of type ERRORS.ARGUMENTS.INVALID_VALUE_FOR_TYPE
        // or wrap it otherwise.
        if (
          !(error instanceof BuidlerError) ||
          error.errorDescriptor !== ERRORS.ARGUMENTS.INVALID_VALUE_FOR_TYPE
        ) {
          throw new BuidlerError(
            ERRORS.ARGUMENTS.INVALID_VALUE_FOR_TYPE,
            {
              value: argumentValue,
              name,
              type: type.name
            },
            error
          );
        }
        throw error;
      }

      return argumentValue;
    };

    const initParsedArguments: {
      errors: BuidlerError[];
      values: TaskArguments;
    } = { errors: [], values: {} };

    const parsedArguments = allTaskParamDefinitions.reduce(
      ({ errors, values }, paramDefinition) => {
        try {
          const paramName = paramDefinition.name;
          const argumentValue = taskArguments[paramName];
          const parsedArgumentValue = parseArgument(
            paramDefinition,
            argumentValue
          );
          if (parsedArgumentValue !== undefined) {
            values[paramName] = parsedArgumentValue;
          }
        } catch (error) {
          errors.push(error);
        }
        return { errors, values };
      },
      initParsedArguments
    );

    const { errors: parseErrors, values: parsedValues } = parsedArguments;

    // if has argument errors, throw the first one
    if (parseErrors.length > 0) {
      throw parseErrors[0];
    }

    // append the rest of arguments that where not in the task param definitions
    const parsedTaskArguments = { ...taskArguments, ...parsedValues };

    return parsedTaskArguments;
  }
}

import { CodeModel, Language, Metadata, Operation, Parameter, codeModelSchema } from '@azure-tools/codemodel';
import { Session, Host, Channel, startSession } from '@azure-tools/autorest-extension-base';
import { values } from '@azure-tools/linq';
import { isNullOrUndefined } from 'util';
import { CliCommonSchema } from '../schema';
import { Helper } from '../helper';
import { NodeExtensionHelper, NodeCliHelper } from '../nodeHelper';
import { FlattenHelper } from '../flattenHelper';

export class CommonNamer {
    codeModel: CodeModel
    cliNamingSettings: CliCommonSchema.NamingConvention
    defaultNamingSettings: CliCommonSchema.NamingConvention
    flag: Set<Metadata>

    constructor(protected session: Session<CodeModel>) {
        this.codeModel = session.model;
    }

    public async init(): Promise<CommonNamer> {
        // any configuration if necessary
        this.cliNamingSettings = Helper.normalizeNamingSettings(await this.session.getValue("cli.naming.cli", {}));
        this.defaultNamingSettings = Helper.normalizeNamingSettings(await this.session.getValue("cli.naming.default", {}));
        return this;
    }

    public process(): CodeModel {
        this.flag = new Set<Metadata>();
        this.applyNamingConvention(this.codeModel);
        this.processGlobalParam();
        this.processSchemas();
        this.processOperationGroups();
        this.processCliOperation();
        this.flag = null;

        this.retrieveCodeModel(this.codeModel);

        return this.codeModel;
    }

    private processSchemas(): void {
        const schemas = this.codeModel.schemas;

        for (const obj of values(schemas.objects)) {
            this.applyNamingConvention(obj);
            for (const property of values(obj.properties)) {
                this.applyNamingConvention(property);
            }
        }

        for (const dict of values(schemas.dictionaries)) {
            this.applyNamingConvention(dict);
            this.applyNamingConvention(dict.elementType);
        }

        for (const enumn of values(schemas.choices)) {
            this.applyNamingConvention(enumn);
            for (const item of values(enumn.choices)) {
                this.applyNamingConvention(item);
            }
        }

        for (const enumn of values(schemas.sealedChoices)) {
            this.applyNamingConvention(enumn);
            for (const item of values(enumn.choices)) {
                this.applyNamingConvention(item);
            }
        }

        for (const arr of values(schemas.arrays)) {
            this.applyNamingConvention(arr);
            this.applyNamingConvention(arr.elementType);
        }

        for (const cons of values(schemas.constants)) {
            this.applyNamingConvention(cons);
        }

        for (const num of values(schemas.numbers)) {
            this.applyNamingConvention(num);
        }

        for (const str of values(schemas.strings)) {
            this.applyNamingConvention(str);
        }
    }

    private retrieveCodeModel(model: CodeModel): void {
        Helper.enumerateCodeModel(model, (n) => {
            if (!isNullOrUndefined(n.target?.language?.['cli'])) {
                // log path for code model
                NodeCliHelper.setCliPath(n.target, n.nodePath);
            }
        });

        // We expect global parameter's cliPath to be like globalParameters$$['cliKey']
        // So enumerate again to override
        const paths = ['globalParameters'];
        this.session.model.globalParameters?.forEach((param) => {
            const cliKey = NodeCliHelper.getCliKey(param, null);
            if (!isNullOrUndefined(cliKey)) {
                paths.push(`['${cliKey}']`);
                NodeCliHelper.setCliPath(param, Helper.joinNodePath(paths));
                paths.pop();
            }
        });
    }

    private processOperationGroups(): void {
        for (const operationGroup of values(this.codeModel.operationGroups)) {
            this.applyNamingConvention(operationGroup);

            for (const operation of values(operationGroup.operations)) {

                // Handle operations in group
                this.applyNamingConvention(operation);
                for (const parameter of values(operation.parameters)) {
                    this.applyNamingConvention(parameter);
                }
                
                for (const request of values(operation.requests)) {
                    if (!isNullOrUndefined(request.parameters)) {
                        for (const parameter of values(request.parameters)) {
                            this.applyNamingConvention(parameter);
                        }
                    }
                }
            }
        }
    }

    private processGlobalParam(): void {
        for (const para of values(this.codeModel.globalParameters)) {
            this.applyNamingConvention(para);
        }
    }

    private processCliOperation(): void {

        // To be backward compatiable, reassign poly operations and parameters' default name and cli name
        for (const operationGroup of values(this.codeModel.operationGroups)) {
            for (const operation of values(operationGroup.operations)) {
                const polyOriginOp = NodeExtensionHelper.getPolyAsResourceOriginalOperation(operation);
                if (!isNullOrUndefined(polyOriginOp)) {
                    this.applyNamingConventionOnCliOperation(polyOriginOp, operation);
                    for (const parameter of values(operation.parameters)) {
                        this.applyNamingConvention(parameter);
                    }
                    
                    for (const request of values(operation.requests)) {
                        if (!isNullOrUndefined(request.parameters)) {
                            for (const parameter of values(request.parameters)) {
                                this.applyNamingConventionOnCliParameter(parameter);
                            }
                        }
                    }
                }
            }
        }
    }

    private applyNamingConventionOnCliOperation(operation: Operation, cliOperation: Operation): void {
        if (cliOperation == null || cliOperation.language == null) {
            this.session.message({ Channel: Channel.Warning, Text: "working in obj has problems" });
            return;
        }
        if (isNullOrUndefined(cliOperation.language['cli'])) {
            cliOperation.language['cli'] = new Language();
        }
        cliOperation.language['cli']['description'] = operation.language.default.description;

        const discriminatorValue = NodeExtensionHelper.getPolyAsResourceDiscriminatorValue(cliOperation);
        cliOperation.language.default.name = Helper.createPolyOperationDefaultName(operation, discriminatorValue);
        cliOperation.language['cli']['name'] = Helper.createPolyOperationCliName(operation, discriminatorValue);
    }

    private applyNamingConventionOnCliParameter(cliParameter: Parameter): void {
        if (cliParameter == null || cliParameter.language == null) {
            this.session.message({ Channel: Channel.Warning, Text: "working in obj has problems" });
            return;
        }

        if (isNullOrUndefined(cliParameter.language['cli'])) {
            cliParameter.language['cli'] = new Language();
        }

        const prop = NodeExtensionHelper.getCliFlattenOrigin(cliParameter);
        if (isNullOrUndefined(prop)) {
            // Is not flattened parameter, use default naming
            this.applyNamingConvention(cliParameter);
            return;
        }

        cliParameter.language['cli']['description'] = prop.language.default.description;

        const prefix = NodeExtensionHelper.getCliFlattenPrefix(cliParameter);
        cliParameter.language.default.name = FlattenHelper.createFlattenedParameterDefaultName(prop, prefix);
        cliParameter.language['cli']['name'] = FlattenHelper.createFlattenedParameterCliName(prop, prefix);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private applyNamingConvention(obj: any): void {
        if (obj == null || obj.language == null) {
            this.session.message({ Channel: Channel.Warning, Text: "working in obj has problems" });
            return;
        }

        if (isNullOrUndefined(obj.language['cli']))
            obj.language['cli'] = new Language();
        if (isNullOrUndefined(obj.language['cli']['name'])) {
            obj.language['cli']['name'] = obj.language.default.name;
        }
        if (isNullOrUndefined(obj.language['cli']['description']))
            obj.language['cli']['description'] = obj.language.default.description;

        if (!isNullOrUndefined(obj['discriminatorValue'])) {
            const dv: string = obj['discriminatorValue'];
            // dv should be in pascal format, let's do a simple convert to snake
            const newValue = Helper.camelToSnake(dv);
            NodeCliHelper.setCliDiscriminatorValue(obj, newValue);
        }

        let lan = 'cli';
        if (!this.flag.has(obj.language[lan])) {
            this.flag.add(obj.language[lan]);
            Helper.applyNamingConvention(this.cliNamingSettings, obj, lan);
        }

        lan = 'default';
        if (!this.flag.has(obj.language[lan])) {
            this.flag.add(obj.language[lan]);
            Helper.applyNamingConvention(this.defaultNamingSettings, obj, lan);
        }
    }
}

export async function processRequest(host: Host): Promise<void> {
    const session = await startSession<CodeModel>(host, {}, codeModelSchema);
    const dumper = await Helper.getDumper(session);
    dumper.dumpCodeModel("namer-pre", session.model);

    const debug = await host.GetValue('debug') || false;
    try {
        const plugin = await new CommonNamer(session).init();
        plugin.process();
    } catch (E) {
        if (debug) {
            console.error(`${__filename} - FAILURE  ${JSON.stringify(E)} ${E.stack}`);
        }
        throw E;
    }
    dumper.dumpCodeModel("namer-post", session.model);

    await Helper.outputToModelerfour(host, session);
    await dumper.persistAsync(host);

}

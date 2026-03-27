/*******************************************************************************
 * ADOBE CONFIDENTIAL
 *  ___________________
 *
 *   Copyright 2017. Adobe Systems Incorporated
 *   All Rights Reserved.
 *
 *  NOTICE:  All information contained herein is, and remains
 *  the property of Adobe Systems Incorporated and its suppliers,
 *  if any.  The intellectual and technical concepts contained
 *  herein are proprietary to Adobe Systems Incorporated and its
 *  suppliers and are protected by all applicable intellectual property
 *  laws, including trade secret and copyright laws.
 *  Dissemination of this information or reproduction of this material
 *  is strictly forbidden unless prior written permission is obtained
 *  from Adobe Systems Incorporated.
 ******************************************************************************/
/* ICC Data used to fill a letter. This includes field values and ICC Control Data (which contains module values).
 *  It represents a letter's complete data set.
 * <p>Note 1: This class does not handle dependency resolution where, for example, a variable's source is a field. Use the <code>resolve()</code>
 *  method on the various data objects: <code>VariableData.resolve()</code>, <code>FieldData.resolve()</code>, <code>ModuleData.resolve()</code>.
 * </p>
 * <p>Note 2: This class provides access to all content targets (targets that has module assignments as opposed to a container layout assignment)
 *  nested at any level, all assigned variables and all assigned fields. While ICC Data represents <b>selected</b> content data only (which means
 *  that a content target will only contain data for selected modules), content targets need not be added/removed (in fact, they cannot be) from
 *  this class -- neither can variables and fields -- since these target/variable/field assignments cannot be altered while filling a letter.</p>
 * <p><b>Warning:</b> No effort is made to guard against circular references if an entity's source path is such that it eventally refers back
 *  to itself (e.g. var1 gt; var2 gt; var1, var1 gt; mod1 gt; var1, field1 gt; mod1 gt; var1 gt; field1, etc.). It is expected that the design
 *  application has taken appropriate measures to prevent authoring of such predicaments.</p>
 * @see com.adobe.icc.dc.data.VariableData#resolve()
 * @see com.adobe.icc.dc.data.FieldData#resolve()
 * @see com.adobe.icc.dc.data.ModuleData#resolve()
 *
 */
var IccData = CM.domain.IccData = new Class({
    className: 'IccData',
    extend: EventDispatcher,
    construct: function (letter, schemaInstanceModel, muted, letterDef, dataSomBindings) {
        this._document = letter;
        this._schemaInstanceModel = schemaInstanceModel;
        this._muted = muted;
        this._letterDef = letterDef;
        this._initializing = false;
        this._fullMergeRunning = false;
        this._enableIncrementalMerge = false;
        this._fbDataBindingsResolved = false;
        this.incrementalMergeRunning = false;
        this._xmlDataSource = null;
        this._dataSourceClone = null;
        this._ddiDataXml = null;
        this._ddiDataClone = null;
        this._xmlMeta = null;
        this._rootDataName = null;
        this.systemContextDDIModel = null;
        this._containerAssignmentMap = new CMMap();
        this._dynamicTablesAssignmentMap = new CMMap();
        this._targetMap = new CMMap();
        this._fieldMap = new CMMap();
        this._variableMap = new CMMap();
        this._allVariablesMap = new CMMap();
        this._taFieldOrderMap = new CMMap();
        this.attchmentData = null; // of Type AttachmentData
        this.isPdfXmlData = false; // Flag for addtional changes in data for preview letter.
        this.mergePendingTargetData = [];
        this.somToDataBinding = dataSomBindings;
        this._hiddenVariablesMap= new CMMap();  // This map instance is created to store the varaiables that are shown from CCR UI & are otherwise hidden

        // this should ideally be retrieve from some API in the 'services' (infrastructure) project
        this._flexConfig = AppConfigInitializer.getInstance().configurationInstance;

        if (this._document.schemaRef && !this._schemaInstanceModel)
            throw new Error(CQ.I18n.getMessage("data dictionary instance required for ") + this._document); // assert

        this._initialize();

    }
});

IccData.prototype._initialize = function () {
    this._initializing = true;
    this._evaluateFieldUnformattedData();
    this._findFields(null, null);
    this._findTargets(this._document.targetAreaAssignments);
    this._findAssignedVariables();
    this._findAttachments(this._document.attachmentAssignmentContainer);
    this._initializing = false;
};

/**
 * Function evaluate unformatted field value for IC draft
 * This is done to to avoid errors if data was submitted with displayPattern on xdpField.
 * @private
 */
IccData.prototype._evaluateFieldUnformattedData = function () {
    var iccXML = this._document.clonedIccXML;
    var fieldFormattedMap = new CMMap();
    if (CCRDefaultActionHandler.prototype.isSavedDraftDocument()) {
        try {
            var letterXML = Form.rte.util.XmlUtil.selectFromPath(iccXML, IccDataElem.LETTER);
            var layoutXml = Form.rte.util.XmlUtil.selectFromPath(letterXML, IccDataElem.LAYOUT);
            if (layoutXml) {
                var fieldsXml = Form.rte.util.XmlUtil.selectFromPath(layoutXml, IccDataElem.FIELDS);
                if (fieldsXml) {
                    var currfieldXml = null;
                    var fieldElements = fieldsXml.elements();
                    for (var index = 0; index < fieldElements.length(); index++) {
                        currfieldXml = fieldElements[index];
                        if (Form.rte.util.XmlUtil.qualifiedName(currfieldXml) != IccDataElem.FIELD) {
                            continue;
                        }
                        var fieldSom = Form.rte.util.XmlUtil.getAttribute(currfieldXml, IccDataElem.REF);
                        var unformattedValue = Form.rte.util.XmlUtil.getAttribute(currfieldXml, IccDataElem.UNFORMATTEDVALUE);
                        fieldFormattedMap.assign(fieldSom, unformattedValue);
                    }
                }
            }
        } catch (e) {
            Debug.warning("[IccData.__evaluateFieldUnformattedData] error in evaluating unformatted value for fieldAssignments");
        }
    }
    this._document.fieldFormattedMap = fieldFormattedMap;
    //remove the clonedXML
    this._document.clonedIccXML = null;
};

IccData.prototype.setDataSomBindings = function (somToDataBinding) {
    if (somToDataBinding) {
        var dataSomFunction = function (dataSomObject) {
            if (dataSomObject.hasOwnProperty("DataSOM")) {
                if (this._rootDataName)
                    return IccDataUtil.changeDataSomExpRoot(dataSomObject.DataSOM, this._rootDataName);
                else
                    return dataSomObject.DataSOM;
            }
            return null;
        };
        var defaultValueFunction = function (dataSomObject) {
            if (dataSomObject.hasOwnProperty("DefaultValue"))
                return dataSomObject.DefaultValue;
            return null;
        };

        this.forEachDynamicTable(this,
            function (dynamicTableData) {
                if (dynamicTableData.dynamicRowSom && somToDataBinding.hasKey(dynamicTableData.dynamicRowSom))
                    dynamicTableData.dynamicRowDataDom = dataSomFunction.call(this, somToDataBinding.value(dynamicTableData.dynamicRowSom));
                else
                    Debug.warning("[IccData._setDataSomBindings] data som could not be found for dynamic table som:" + dynamicTableData.dynamicRowSom);
                return true;
            });

        this.forEachField(this,
            function (fieldData) {
                if (fieldData.formSomExp && somToDataBinding.hasKey(fieldData.formSomExp)) {
                    fieldData.dataSomExp = dataSomFunction.call(this, somToDataBinding.value(fieldData.formSomExp));
                    fieldData.setDefaultValue(defaultValueFunction(somToDataBinding.value(fieldData.formSomExp)));
                }
                else
                    Debug.warning("[IccData._setDataSomBindings] data som and default value (if any) could not be found for field som:" + fieldData.formSomExp);
                return true;
            });

        this.forEachTarget(this,
            function (targetData) {
                if (targetData.formSomExp && somToDataBinding.hasKey(targetData.formSomExp)) {
                    targetData.dataSomExp = dataSomFunction.call(this, somToDataBinding.value(targetData.formSomExp));
                    //TODO: PF : Set default value
                }
                else
                    Debug.warning("[IccData._setDataSomBindings] data som could not be found for target som:" + targetData.formSomExp);
                return true;
            });
        this._updateFieldDefaultValues();
        this._fbDataBindingsResolved = true;
        this._notifyChange();
    }
};
/**
 * @private
 * Add a variable to the variable map, creating the required data for it as well.
 * @param va The assignment containing the variable to be added.
 * @param treatAsPlaceholder If true, the variable will be treated as regular placeholder even if it's a Data Dictionary Element variable.
 * @return The variable data object created for the specified variable.
 */
IccData.prototype._addVariableToMap = function (va, treatAsPlaceholder, map) {
    treatAsPlaceholder = treatAsPlaceholder !== undefined ? treatAsPlaceholder : false;
    map = map !== undefined ? map : this._variableMap;
    var vI = new VariableInstance(va, this);
    vI.forcePlaceholder = treatAsPlaceholder;
    vI.schemaInstanceModel = this._schemaInstanceModel;

    var orgVd = map.value(vI.name);
    orgVd = orgVd || vI;
    if (map.hasKey(vI.name)) {
        if (orgVd.assignment.variable.dataType != vI.assignment.variable.dataType)
            orgVd.assignment.variable.dataType = Variable.STRING_TYPE;

        // if old variable assignment is different then new then replace its bindRefType and bindRef
        // For example, Variable Assignment was binded to Field but while generating VA from module this information is lost (As in case of document VA are parsed after TA-Modules)
        if(orgVd.assignment.bindRefType != vI.assignment.bindRefType) {
            orgVd.assignment.bindRefType = vI.assignment.bindRefType;
            orgVd.assignment.bindRef = vI.assignment.bindRef;
        }
        if (vI.assignment.multiLine && !orgVd.assignment.multiLine) {
            orgVd.assignment.multiLine = vI.assignment.multiLine;
        }
    }

    else if(this._hiddenVariablesMap.hasKey(vI.name)){
        var missingAssignment = this._hiddenVariablesMap.value(vI.name);

        if(missingAssignment.caption)
            orgVd.assignment.caption = missingAssignment.caption;

        if(missingAssignment.bindRefType)
            orgVd.assignment.bindRefType = missingAssignment.bindRefType;

        if(missingAssignment.bindRef)
            orgVd.assignment.bindRef = missingAssignment.bindRef;

        if(missingAssignment.dataModule)
            orgVd.assignment.dataModule = missingAssignment.dataModule;

        if(missingAssignment.defaultValue)
            orgVd.assignment.defaultValue = missingAssignment.defaultValue;


        if(missingAssignment.displayPatternType)
            orgVd.assignment.displayPatternType = missingAssignment.displayPatternType;

        if(missingAssignment.displayPictureClause)
            orgVd.assignment.displayPictureClause = missingAssignment.displayPictureClause;

            orgVd.assignment.editable = missingAssignment.editable;
            orgVd.assignment.equivalent = missingAssignment.equivalent;
            orgVd.assignment.locked = missingAssignment.locked;
            orgVd.assignment.multiLine = missingAssignment.multiLine;
            orgVd.assignment.optional = missingAssignment.optional;

        if(missingAssignment.toolTip)
            orgVd.assignment.toolTip = missingAssignment.toolTip;

        if(missingAssignment.validators)
            orgVd.assignment.validators = missingAssignment.validators;
    }

    if (Variable.isSchemaType(vI.type)) {
        if (map.hasKey(vI.name)) {
            var oldVd = map.value(vI.name);
            orgVd.assignment.editable = (oldVd.editable || !(vI.protect));
        }
        else {
            orgVd.assignment.editable = !(vI.protect);
        }
    }

    else
        orgVd.assignment.editable = vI.editable;
    if(vI.toolTip){
        orgVd.toolTip = vI.toolTip;
    }
    if(vI.displayPictureClause || orgVd.displayPictureClause){
        orgVd.displayPictureClause = vI.displayPictureClause || orgVd.displayPictureClause;
    }
    if(vI.defaultValue){
        orgVd.defaultValue = vI.defaultValue;
    }
    if(vI.assignment.dataModule) {
        orgVd.assignment.dataModule = vI.assignment.dataModule;
    }
    if(vI.assignment.validators){		//validators in letter's variables
        orgVd.assignment.validators = vI.assignment.validators;
    }
    orgVd.assignment.optional = vI.assignment.optional;

    if(vI.caption || orgVd.caption){
        orgVd.assignment.caption = vI.assignment.caption || orgVd.assignment.caption;
    }
    map.assign(vI.name, orgVd);
    this._allVariablesMap.assign(vI.name, orgVd);
    // this._allVariablesMap.assign(vI.name, orgVd);
    return orgVd;
};

/**
 * @private
 * Add unknown variables found in the specified module and any of its children (if applicable) to the variable map. This method may
 *  be called after initialization (e.g. as a result of selecting a new module for inclusion in the letter).
 * @param mod The module whose unknown variables are to be added.
 */
IccData.prototype._findNewVariables = function (mod) {
    var variable, va, variableInstance = null;
    if(mod.variableList && mod.variableList.length > 0){
        for (var i = 0; i < mod.variableList.length; i++) {
            variable = mod.variableList[i];
            if (!this._variableMap.hasKey(variable.name)) {
                va = IccDataUtil.newVariableAssignment(variable);
                this.updateVariableAssignment(va);
                variableInstance = this._addVariableToMap(va, false);
                if (this._initializing) {
                    variableInstance.muted = true; // initially muted until it is resolved later via IccDataResolver.resolveLetter()
                    variableInstance.deafened = true; // initially deafened until it is resolved later via IccDataResolver.resolveLetter()
                }
            }
            else if (Variable.isSchemaType(variable.type) && !variable.protect) {
                //For Unprotected DDE variable mark the existing Variable Data Assignment as editable.
                variableInstance = this._variableMap.value(variable.name);
                variableInstance.assignment.editable = !(variable.protect);
            }
            else {
		variableInstance = this._variableMap.value(variable.name);
		if (variableInstance.assignment.variable.subType != variable.subType) {
		    variableInstance.assignment.variable.subType = variable.subType;
		    variableInstance.assignment.variable.valueSet = variable.valueSet;
		}
	   }
        }
    }
    var j;
    if (mod.type == DataModuleType.CONDITION) {
        var cma = null;
        for (j = 0; j < mod.assignmentList.length; j++) {
            cma = mod.assignmentList[j];
            this._findNewVariables(cma.target);
        }
    }
    else if (mod.type == DataModuleType.LIST) {
        var lma = null;
        for (j = 0; j < mod.assignmentList.length; j++) {
            lma = mod.assignmentList[j];
            this._findNewVariables(lma.target);
        }
    }
    // else, module is basic text or image with no child content to search
};
IccData.prototype._findAssignedVariables = function () {
    Debug.info("Finding Assignment Fields...");
    if (!this._initializing)
        throw new Error(CQ.I18n.getMessage("this method can only be called during initialzation")); // assert
    var va, vI;
    var vaList = this._document.variableAssignments;    //fetching all variables at document level
    for (var i = 0; i < vaList.length; i++) {
        va = vaList[i];
        if (va.variable == null) {
            var varInstRef = this._allVariablesMap.value(va.variableName);  //allvariables-map containing only those variables which are in non-optional DFs
            if(varInstRef != null){
                if(varInstRef && varInstRef.assignment) {
                    va.variable = varInstRef.assignment.variable;
                }
                if(va.variable == null) {
                    throw new Error(CQ.I18n.getMessage("variable assignment must have assigned variable ") + va); // assert
                }
                //reformatting schema element [CQ-4306982]
                if (va.variable.dataType === "STRING" &&
                    va.bindRefType === "SCHEMA" && va.defaultValue) {
                    va.variable.unformattedValue = va.defaultValue;
                }
                vI = this._addVariableToMap(va, false);
                vI.muted = true; // initially muted until it is resolved later via IccDataResolver.resolveLetter()
                vI.deafened = true; // initially deafened until it is resolved later via IccDataResolver.resolveLetter()
            }

            else {
                this._hiddenVariablesMap.assign(va.variableName, va);
                /* vI = this._addVariableToMap(va, false);
                 vI.muted = true; // initially muted until it is resolved later via IccDataResolver.resolveLetter()
                 vI.deafened = true; // initially deafened until it is resolved later via IccDataResolver.resolveLetter()  */
                console.warn("Ignoring variable as variable instance is not found");
            }
        }
    }
};

IccData.prototype._findFields = function (fieldAssignments, containerSom) {
    Debug.info("Finding Fields...");
    if (!this._initializing)
        throw new Error(CQ.I18n.getMessage("this method can only be called during initialzation")); // assert

    var faList = fieldAssignments ? fieldAssignments : this._document.fieldAssignments;
    var fa, fI;
    for (var i = 0; i < faList.length; i++) {
        if (faList instanceof Array)
            fa = faList[i];
        else
            fa = faList.getItemAt(i);
        if (this.rootDataName == null)
            this._setRootDataName(fa.field.path);

        if (fa.bindRefType == DataInstance.BINDING_IGNORE)
            continue; // skip ignored fields

        var newSom = IccDataUtil.getAbsoluteContainerSomExp(containerSom, fa.field.path);

        //Storing the unformatted value in case of Field,
        //this will be used when reloading the CCRDocumentInstance draft.
        //may be removed in future version.
        fI = new FieldInstance(fa, this);
        fI.formSomExp = newSom;

        fa.defaultValue = IccDataUtil.getUnformattedFieldValue(fa.defaultValue, this._document.fieldFormattedMap, fI.formSomExp);
        fI.unformattedValue = fa.defaultValue;;
        //fI.dataSomExp = this.dataSomFunction(this.somToDataBinding.value(fI.formSomExp));
        //fI.setDefaultValue(this.defaultValueFunction(this.somToDataBinding.value(fI.formSomExp)));
        fI.schemaInstanceModel = this._schemaInstanceModel;
        fI.muted = true; // initially muted until it is resolved later via IccDataResolver.resolveLetter()
        fI.deafened = true; // initially deafened until it is resolved later via IccDataResolver.resolveLetter()
        this._fieldMap.assign(fI.formSomExp, fI);
        fI.on(FieldDataEvent.FIELD_CHANGE_EVENT, this._fieldDataChangeHandler, this);
    }
    if (!fieldAssignments)
        this._findContainerFields(this._document.targetAreaAssignments, ""); // possibly recursive
};
/**
 * @private
 * Find all fields nested in container layout assignments in the letter, if any, and add them to the Field Map. Also determine the root data element
 *  name if it hasn't been determined yet.
 * @param targetAreaAssignments List of target area assignments to search for fields.
 * @param containerSom
 */
IccData.prototype._findContainerFields = function (targetAreaAssignments, containerSom) {

    containerSom = containerSom !== undefined ? containerSom : "";
    if (!this._initializing)
        throw new Error(CQ.I18n.getMessage("this method can only be called during initialzation")); // assert

    if (!targetAreaAssignments)
        return;
    var index1, index, taa;
    for (index1 = 0; index1 < targetAreaAssignments.length; index1++) {
        taa = targetAreaAssignments[index1];
        if (this.rootDataName == null)
            this._setRootDataName(taa.targetArea.path);

        if (taa.containerLayoutAssignment != null) {
            //Calculate the absolute target area som by adding the target path to container som
            var newSom = IccDataUtil.getAbsoluteContainerSomExp(containerSom, taa.targetArea.path);
            var containerLayoutAssignment = taa.containerLayoutAssignment;
            if (!containerLayoutAssignment.path)
                containerLayoutAssignment.path = UIDUtil.createUID();
            this._containerAssignmentMap.assign((taa.containerLayoutAssignment).path, [newSom, (taa.containerLayoutAssignment)]);

            var containerLayout = taa.containerLayoutAssignment.fragmentLayout;
            // target area has an altered layout -- process its fields, if any, and digg further into its target assignments, if any

            var fieldAssignments = (taa.containerLayoutAssignment).fieldAssignments;
            if (fieldAssignments) {
                var table, tmpFieldAssignment, staticFieldIdAssignmentMap = new CMMap();
                for (index = 0; index < fieldAssignments.length; index++) {
                    tmpFieldAssignment = fieldAssignments[index];
                    //Assume all fields are static table field
                    staticFieldIdAssignmentMap.assign(tmpFieldAssignment.field.id, tmpFieldAssignment);
                }
                if (containerLayout && containerLayout.tables) {
                    for (index = 0; index < containerLayout.tables.length; index++) {
                        table = containerLayout.tables[index];
                        if (table.dynamicTable && table.bodyRows && table.bodyRows.length == 1) {
                            var dynamicRow = table.bodyRows[0];
                            if (dynamicRow.fields) {
                                var dynamicFieldAssignments = new ArrayCollection();
                                for (var j = 0; j < dynamicRow.fields.length; j++) {
                                    var dynamicField = dynamicRow.fields[j];
                                    if (staticFieldIdAssignmentMap.hasKey(dynamicField.id)) {
                                        //Remove repeating fields from static table field map
                                        var dynamicFieldAssignment = staticFieldIdAssignmentMap.remove(dynamicField.id);
                                        dynamicFieldAssignments.addItem(dynamicFieldAssignment);
                                    }
                                }
                                //Calculate the absolute table row som by adding the target path to container som
                                var tableRowSom = IccDataUtil.getAbsoluteContainerSomExp(newSom, dynamicRow.rowSOMExpression);
                                var dynamicTableData = new DynamicTableData(this);
                                dynamicTableData.dynamicRowSom = tableRowSom;
                                dynamicTableData.fieldAssignments = dynamicFieldAssignments.toArray();
                                this._dynamicTablesAssignmentMap.assign(dynamicTableData.dynamicRowSom, dynamicTableData);
                            }
                        }
                    }
                }
                if (staticFieldIdAssignmentMap.length > 0)
                    this._findFields(new ArrayCollection(staticFieldIdAssignmentMap.values), newSom); // process these field assignments only but make sure the list isn't null otherwise we'll be in an infinite loop!
            }
            this._findContainerFields((taa.containerLayoutAssignment).targetAreaAssignments, newSom); // recursive
        }
    }
};
IccData.prototype._findTargets = function (targetAreaAssignments, containerSom, containerLayout) {
    Debug.info("Finding Targets...");
    if (!this._initializing)
        throw new Error(CQ.I18n.getMessage("this method can only be called during initialzation")); // assert

    if (!targetAreaAssignments)
        return;
    var ma, taa, targetInstance;
    for (var i = 0; i < targetAreaAssignments.length; i++) {
        taa = targetAreaAssignments[i];
        if (this._rootDataName == null)
            this._setRootDataName(taa.targetArea.path);
        var newSom = IccDataUtil.getAbsoluteContainerSomExp(containerSom, taa.targetArea.path);
        if (taa.containerLayoutAssignment) {
            var containerAssignment = taa.containerLayoutAssignment;
            this._findTargets(containerAssignment.targetAreaAssignments, newSom, containerAssignment.containerLayout); // recursive*/
        } else {
            targetInstance = new TargetInstance(taa, this);
            targetInstance.formSomExp = newSom + IccData.MODULE_CONTAINER_SUBFORM;
            targetInstance.muted = true; // initially muted until it is resolved later via IccDataResolver.resolveLetter()
            //targetInstance.dataSomExp = this.dataSomFunction(this.somToDataBinding.value(targetInstance.formSomExp));
            targetInstance.on(TargetDataEvent.TARGET_CONTENT_CHANGE_EVENT, this._targetDataChangeHandler, this);

            var title = taa.title || taa.targetArea.displayName;
            if (containerLayout)
                targetInstance.localizedName = LocalizationUtils.getLocalizedPropertyValue(taa, containerLayout, "title", title);
            else
                targetInstance.localizedName = LocalizationUtils.getLocalizedPropertyValue(taa, this.document.form, "title", title);

            this._targetMap.assign(targetInstance.formSomExp, targetInstance);

            // look for mandatory and removable content (ignore optional content since it isn't initially selected)
            for (var j = 0; j < taa.moduleAssignments.length; j++) {
                var moduleInstance;
                ma = taa.moduleAssignments[j];
                // Check if image or chart is used in assignment instead of assetRef
                if(!ma.assetRef && ma.computedAssetRef) {
                    ma.assetRef = ma.computedAssetRef;
                }

                // If module assignment assetRef is missing then ignore it.
                if(!ma.assetRef) {
                    Debug.warning("Ignoring module assignment " + ma.path + " due to missing assetRef");
                    continue;
                }
                //This inserts the module for CCRDocumentInstance-IC-draft in case of extraContent [FreeText and NewLine]
                if (ma.assetRef.indexOf(ContentUtil.NEWLINE_ID_PREFIX) !== -1 || ma.assetRef.indexOf(ContentUtil.FREETEXT_ID_PREFIX) !== -1) {
                    ma.dataModule.id = ma.assetRef;
                    ma.optional = true;
                    ma.selected = true;
                    moduleInstance = this.newModuleData(ma, targetInstance); // will add new (unknown) variables if any
                    moduleInstance.optional = true;
                    moduleInstance.selected = true;
                    moduleInstance.extra = true;
                    targetInstance.insertModule(moduleInstance, -1);
                } else if (!ma.optional || ma.preSelected) {
                    // add to content target
                    moduleInstance = this.newModuleData(ma, targetInstance); // will add new (unknown) variables if any
                    moduleInstance.muted = true; // initially muted until it is resolved later via IccDataResolver.resolveLetter()
                    moduleInstance.deafened = true; // initially deafened until it is resolved later via IccDataResolver.resolveLetter()
                    targetInstance.insertModule(moduleInstance, -1);
                } else if (ma && ma.dataModule){
                    var variables = ma.dataModule.variableList;
                    if (variables) {
                        for (var index = 0; index < variables.length; index ++) {
                            if(this.getVariableData(variables[index], true) == null){   //handling the check here(we don't want to throw error) as our addNewVariable is used at multiple places
                                this.addNewVariable(variables[index], false, this._allVariablesMap);
                            }
                        }
                    }
                }
            }
        }
    }
};
IccData.prototype._findAttachments = function (attachmentAssignmentContainer) {
    Debug.info("Finding Attachments...");
    if (!this._initializing)
        throw new Error(CQ.I18n.getMessage("this method can only be called during initialization")); // assert

    if (!attachmentAssignmentContainer)
        return;

    this.attchmentData = this.newAttachmentData(attachmentAssignmentContainer);
};

IccData.prototype.newAttachmentData = function (attachmentAssignmentContainer) {
    var attachInstance = new AttachmentInstance(attachmentAssignmentContainer, this);
    attachInstance.on(AttachmentDataEvent.ATTACHMENT_CONTENT_CHANGE_EVENT, this._attachmentDataChangeHandler, this);
    if (attachmentAssignmentContainer == null || attachmentAssignmentContainer.attachmentAssignments == null)
        return attachInstance;

    var ma;
    for (var i = 0; i < attachmentAssignmentContainer.attachmentAssignments.length; i++) {
        ma = attachmentAssignmentContainer.attachmentAssignments[i];
        if (!ma.optional || ma.preSelected) {
            // add to content target
            var moduleInstance = this.newModuleData(ma, attachInstance); // will add new (unknown) variables if any
            moduleInstance.muted = true; // initially muted until it is resolved later via IccDataResolver.resolveLetter()
            moduleInstance.deafened = true; // initially deafened until it is resolved later via IccDataResolver.resolveLetter()
            moduleInstance.isAttachmentContent = true;
            attachInstance.insertModule(moduleInstance);
        }
    }
    return attachInstance;
};

/**
 * Creates a module data object or appropriate extended type for the specified assignment and initializes the module data object's properties
 *  given the properties of the assignment.
 * @param assignment The <code>ModuleAssignment</code> or <code>LDMAssignment</code> or <code>CDMAssignment</code> for which to create new module data.
 * @param parent
 * @return A new <code>ModuleData</code> object for text/image modules, <code>ListData</code> for list modules and <code>ConditionData</code>
 *  for conditional modules.*/
IccData.prototype.newModuleData = function (assignment, parent) {
    if (!assignment)
        throw new Error(CQ.I18n.getMessage("invalid assignment: cannot create module data")); // assert

    if (!DataModuleType.isModuleAssignment(assignment) && !DataModuleType.isLDMAssignment(assignment) && !DataModuleType.isCDMAssignment(assignment))
        throw new Error(CQ.I18n.getMessage("assignment must be either ModuleAssignment or LDMAssignment or CDMAssignment")); // assert

    var ma = new ModAssign(assignment);

    // look for new variables **BEFORE** creating the module data to ensure that all variables exist in the map (note that
    //  all variables used in the module's content must be present in the module's variableList property and a module can
    //  only add dependencies on the variables it knows about which are those defined in its content so adding variables to
    //  the map here will be sufficient to ensure that every module added can find all of its variables in the variable map)
    this._findNewVariables(ma.module);

    var data = null;

    if (DataModuleType.isListDataModule(ma.module))
        data = new ListModuleInstance(ma, this, parent);
    else if (DataModuleType.isConditionalDataModule(ma.module))
        data = new ConditionModuleInstance(ma, this, parent);
    else if (DataModuleType.isTBX(ma.module))
        data = new TextModuleInstance(ma, this, parent);
    else if (DataModuleType.isImageModule(ma.module))
        data = new ImageModuleInstance(ma, this, parent);
    else if (DataModuleType.isContentDataModule(ma.module))
        data = new ContentModuleInstance(ma, this, parent);
    else if (DataModuleType.isChartAssignment(ma.module))
        data = new ImageModuleInstance(ma, this, parent, true);
    else // text or image
        data = new ModuleInstance(ma, this, parent);

    data.schemaInstanceModel = this.schemaInstanceModel;
    return data;
};
/**
 * Fetches the <code>VariableData</code> associated with the specified variable.
 * @param v <code>Variable</code>, <code>Variable.name</code>, or <code>VariableAssignment</code> for the variable whose <code>VariableData</code> is sought.
 * @param test True if the method call is meant to test whether the variable exists in the letter; false if the method call is expected to yield an associated
 *  <code>VariableData</code> object.
 * @return The <code>VariableData</code> associated with the variable or null if the variable is not known (not in the letter).
 * @throws Variable is not known in letter (only if <code>test</code> is false)*/
IccData.prototype.getVariableData = function (v, test) {
    test = test !== undefined ? test : false;
    var name = null;
    if (ClassUtil.isVariable(v))
        name = v.name;
    else if (v instanceof Variable)
        name = v.name;
    else if (ClassUtil.isVariableAssignment(v))
        name = v.variable.name;
    else if (typeof v == "string")
        name = v;

    if (name && this._variableMap.hasKey(name))
        return this._variableMap.value(name);

    if (!test)
        throw new Error(CQ.I18n.getMessage("Variable ") + v + CQ.I18n.getMessage(" is not known in letter ") + this._document);

    return null;
};

/**
 * Determines if the specified variable has an assignment in the letter.
 * @param v <code>Variable</code>, <code>Variable.name</code>, or <code>VariableAssignment</code> identifying the variable.
 * @return True if the variable has a known assignment in the letter; false otherwise.*/
IccData.prototype.variableInLetter = function (v) {
    return this.getVariableData(v, true) != null;
};

/**
 * Returns true if the letter has variables.
 *
 * @return*/
IccData.prototype.hasVariables = function () {
    return !this._variableMap.isEmpty;
};

/**
 * Returns an array of <code>VariableData</code> objects for every variable assigned to the letter.
 * <p>Note that it is more efficient to use the <code>forEachVariable()</code> method to iterate the variable set rather than iterating through
 *  this array.</p>
 * <p><b>Warning:</b> Variables are not guarranteed to be in the same order as in the letter's variable assignments collection.</p>
 *
 * @return*/
IccData.prototype.getVariables = function () {
    return this._variableMap.values;
};

IccData.prototype.forEachVariable = function (context, handler) {
    this._variableMap.forEach(context,
        function (fieldSom, fieldInstance) {
            return handler.call(context, fieldInstance);
        });
};
/**
 * Adds a new variable to the ICC Data.
 * @param v The new variable to add.
 * @param treatAsPlaceholder If true, the variable will be treated as regular placeholder even if it's a Data Dictionary Element variable.
 * @return The variable data object created for the specified variable.
 * @throws Error The variable is already known to the letter.*/
IccData.prototype.addNewVariable = function (v, treatAsPlaceholder, map) {
    treatAsPlaceholder = treatAsPlaceholder !== undefined ? treatAsPlaceholder : false;
    if (this.getVariableData(v, true))
        throw new Error(CQ.I18n.getMessage("variable ") + v + CQ.I18n.getMessage(" is already known to the letter"));

    var va = IccDataUtil.newVariableAssignment(v, treatAsPlaceholder);
    this.updateVariableAssignment(va);
    return this._addVariableToMap(va, treatAsPlaceholder, map);
};

//
// Field Methods
//

/**
 * @private
 * Dispatched when a field's value and/or resolution status changes.
 */
IccData.prototype._fieldDataChangeHandler = function (event) {
    this._notifyChange();
    if (FormBridgeServiceDelegate.instance.connected && !this.muted) {
        var changedField = event.data;
        var value = "";
        if (MimeType.FORMAT_RICHTEXT == changedField.mimeFormat || MimeType.FORMAT_XMLTEXT == changedField.mimeFormat) {
            // value is XHTML or FlashHTML
            value = this._makeXfaRichText(changedField.editValue, changedField.mimeFormat);
        } else
            value = changedField.value;
        this.trigger(new LetterDataChangeEvent(LetterDataChangeEvent.LETTER_DATA_CHANGE_START, null, LetterDataChangeEvent.CHANGETYPE_FIELD));
        //FormBridgeServiceDelegate.instance.pdfSetFieldDataNode(changedField.formSomExp, changedField.dataSomExp, value)
        FormBridgeServiceDelegate.instance.pdfSetFieldValue(changedField.formSomExp, value, changedField.dataType).addHandlers(
            function (data) {
                Debug.info("pdfSetFieldValue success:" + changedField.formSomExp);
                this.trigger(new LetterDataChangeEvent(LetterDataChangeEvent.LETTER_DATA_CHANGE, null, LetterDataChangeEvent.CHANGETYPE_FIELD));
            },
            function (fbError) {
                Debug.info("pdfSetFieldValue failed:" + changedField.formSomExp + " ,cause:" + fbError);
                this.trigger(new LetterDataChangeEvent(LetterDataChangeEvent.LETTER_DATA_CHANGE, null, LetterDataChangeEvent.CHANGETYPE_FIELD));
            }, this);
    }
};

/**
 * Fetches the <code>FieldData</code> associated with the specified field.
 * @param f <code>Field</code>, <code>Field.id</code>, or <code>FieldAssignment</code> whose <code>FieldData</code> is sought.
 * @param containerAssignmentId
 * @return The <code>FieldData</code> associated with the field.
 * @throws Field is not in letter.*/
IccData.prototype.getFieldData = function (f, containerAssignmentId) {
    var containerSom = (this._containerAssignmentMap.value(containerAssignmentId)) ? this._containerAssignmentMap.value(containerAssignmentId)[0] : "";
    var som = null;
    if (ClassUtil.isField(f))
        som = IccDataUtil.getAbsoluteContainerSomExp(containerSom, f.path);
    else if (ClassUtil.isFieldAssignment(f))
        som = IccDataUtil.getAbsoluteContainerSomExp(containerSom, f.field.path);
    else if (typeof f == "string") { // expecting Field ID
        // find Field SOM for the given ID

        // lookup in the letter's layout fields
        if (!containerAssignmentId) {
            som = this._lookupFieldSOM(f, this._document.fieldAssignments);
            som = IccDataUtil.getAbsoluteContainerSomExp(containerSom, som);
        }
        else {
            var containerAssignment = (this._containerAssignmentMap.value(containerAssignmentId))
                ? this._containerAssignmentMap.value(containerAssignmentId)[1] : null;
            // did not find the Field (SOM) yet...look into the Container Layouts
            som = this._lookupFieldSOM(f, containerAssignment.fieldAssignments);
            som = IccDataUtil.getAbsoluteContainerSomExp(containerSom, som);
        }
    }

    if (som)//remove xfa[0].template[0]
        som = IccDataUtil.getFormSomExp(som);

    if (som && this._fieldMap.hasKey(som))
        return this._fieldMap.value(som);

    throw new Error(CQ.I18n.getMessage("Field ") + f + CQ.I18n.getMessage(" is not in letter ") + this._document);
};

/**
 * @private
 * Lookup the Field's SOM (in the Letter template) given its ID.
 */
IccData.prototype._lookupFieldSOM = function (fieldId, fieldAssignments) {
    if (fieldAssignments) {
        for (var fa, index = 0; index < fieldAssignments.length; index++) {
            fa = fieldAssignments[index];
            if (fa.field.id === fieldId)
                return fa.field.path; // return the SOM, we found it!
        }
    }
    return null;
};

/**
 * Returns true if the letter has dynamic tables.
 *
 * @return*/
IccData.prototype.hasDynamicTables = function () {
    return !this._dynamicTablesAssignmentMap.isEmpty;
};

/**
 * Retrieves a map of Dynamic Table Row SOM expressions to associated <code>[dataSom, FieldAssignmentList]</code> objects for all dynamic tables found in the letter
 *  (deep into container layouts, if any).
 * @return Map of Dynamic Table Row SOM expressions to associated <code>[dataSom, FieldAssignmentList]</code> objects.*/
IccData.prototype.getDynamicTableRowSoms = function () {
    //dynamic table is based on Som
    return this._dynamicTablesAssignmentMap;
};

/**
 * Calls the specified handler for every dynamic table in the letter.
 * @param context
 * @param handler Function to call. Expected signature: <code>function(dynamicTable:DynamicTableData)</code>. Return true to continue iterating;
 *  false to stop.*/
IccData.prototype.forEachDynamicTable = function (context, handler) {
    this._dynamicTablesAssignmentMap.forEach(context,
        function (dynamicRowSom, dynamicTable) {
            return handler.call(this, dynamicTable);
        });
};

/**
 * Retrieves a map of Form SOM expressions to associated <code>FieldData</code> objects for all fields found in the letter
 *  (deep into container layouts, if any).
 * <p><b>Warning:</b> Form SOMs are not guarranteed to be in the same order as in the letter's field assignments collection.</p>
 * @return Map of Form SOM expressions to associated <code>FieldData</code> objects.*/
IccData.prototype.getFieldSoms = function () {
    //fieldMap is based on Som
    return this._fieldMap;
};

/**
 * Returns true if the letter has fields (nested container layout fields included).
 *
 * @return*/
IccData.prototype.hasFields = function () {
    return !this._fieldMap.isEmpty;
};

/**
 * Returns an array of <code>FieldData</code> objects for every field assigned to the letter (nested container layout fields included).
 * <p>Note that it is more efficient to use the <code>forEachField()</code> method to iterate the field set rather than iterating through
 *  this array.</p>
 * <p><b>Warning:</b> Fields are not guarranteed to be in the same order as in the letter's field assignments collection.</p>
 *
 * @return*/
IccData.prototype.getFields = function () {
    return this._fieldMap.values;
};

IccData.prototype.forEachField = function (context, handler) {
    this._fieldMap.forEach(context,
        function (fieldSom, fieldInstance) {
            return handler.call(context, fieldInstance);
        });
};
/**
 * @private
 * Dispatched when a target's content changes.
 */
IccData.prototype._targetDataChangeHandler = function (event) {
    this._notifyChange();
    /*
     * TODO:PF  1. send Data in chunks
     */
    //If IccData is muted we do not need to schedule targetDataMerge as unmute would automatically call _generateData
    if (!this.muted && this.mergePendingTargetData.indexOf(event.data) < 0) {
        this.mergePendingTargetData.push(event.data);
        Deferred.doLater(this._mergeTargetData, null, this);
        if (!this.incrementalMergeRunning && this.enableIncrementalMerge)
            this.trigger(new LetterDataChangeEvent(LetterDataChangeEvent.LETTER_DATA_CHANGE_START, null, LetterDataChangeEvent.CHANGETYPE_TARGETAREA));
    }
};
/**
 * Note: From IccData, we are explicitly pushing targetXml and fieldXml to FormBridge.
 * Ideally, This should happen via LetterPdfContainer to seperate the resonsibilties, but given the effort required and life of the code (may be next few months)
 * we are avoiding that. Will relook if more changes are requred in this area.
 */
IccData.prototype._mergeTargetData = function () {
    if (this.incrementalMergeRunning || !this.enableIncrementalMerge) {
        //Target Merge is already running and it would automaticaly schedule next merge.
        //Or incremental merge has not been enabled yet. Once it is enabled, it would take care of scheduling next merge.
        return;
    }
    var bridgeApi = FormBridgeServiceDelegate.instance;
    if (bridgeApi.connected && this.mergePendingTargetData.length > 0) {
        var pendingTarget = this.mergePendingTargetData.shift();
        // value is XHTML or FlashHTML
        var targetValueXml = this._makeTargetXml(pendingTarget);
        if (!targetValueXml) {
            //TargetData is under resolution. so skipping it's merger. Skipped calling remerge as that would also be called when resolution is complete.
            Deferred.doLater(this._mergeTargetData, null, this);
            return;
        }
        this.incrementalMergeRunning = true;
        var targetValue = Form.rte.util.XfaUtil.print(targetValueXml, {pretty: true});
        //TODO : System.disposeXML(targetValueXml); //Do not use targetValueXml after dispose
        Debug.info("_mergeTargetData start:" + pendingTarget.formSomExp);
        bridgeApi.pdfSetDataBuffer(targetValue, pendingTarget.dataSomExp, pendingTarget.formSomExp).addHandlers(
            function (data) {
                Debug.info("_mergeTargetData success:" + pendingTarget.formSomExp);
                if (this.mergePendingTargetData.length == 0) {
                    bridgeApi.pdfRemergeData().addHandlers(
                        function (result) {
                            Debug.info("pdfRemergeData success:");
                            this.incrementalMergeRunning = false;
                            this.trigger(new LetterDataChangeEvent(LetterDataChangeEvent.LETTER_DATA_CHANGE, null, LetterDataChangeEvent.CHANGETYPE_TARGETAREA));
                            Deferred.doLater(this._mergeTargetData, null, this);
                        },
                        function (bridgeError) {
                            Debug.error("Error in merging pdf data using pdfRemergeData:" + bridgeError);
                            this.incrementalMergeRunning = false;
                            this.trigger(new LetterDataChangeEvent(LetterDataChangeEvent.LETTER_DATA_CHANGE, null, LetterDataChangeEvent.CHANGETYPE_TARGETAREA));
                            Deferred.doLater(this._mergeTargetData, null, this);
                        }, this);
                } else {
                    this.incrementalMergeRunning = false;
                    Deferred.doLater(this._mergeTargetData, null, this);
                }
            },
            function (bridgeError) {
                Debug.info("_targetDataChangeHandler failed:" + pendingTarget.formSomExp + " ,cause:" + bridgeError);
                this.incrementalMergeRunning = false;
                Deferred.doLater(this._mergeTargetData, null, this);
            }, this);
    }
};

IccData.prototype._attachmentDataChangeHandler = function (event) {
    this._notifyChange();
};

/**
 * Fetches the <code>TargetData</code> associated with the specified target area.
 * @param t <code>TargetArea</code>, <code>TargetArea.id</code>, or <code>TargetAreaAssignment</code> identifying the content target sought.
 * @param containerAssignmentId
 * @return The <code>TargetData</code> associated with the target area.
 * @throws Error Target Area is not in letter.*/
IccData.prototype.getTargetData = function (t, containerAssignmentId) {
    var containerSom = (this._containerAssignmentMap.value(containerAssignmentId)) ? this._containerAssignmentMap.value(containerAssignmentId)[0] : "";
    var som = null;
    if (ClassUtil.isTargetArea(t))
        som = IccDataUtil.getAbsoluteContainerSomExp(containerSom, t.path);
    else if (ClassUtil.isTargetAreaAssignment(t))
        som = IccDataUtil.getAbsoluteContainerSomExp(containerSom, t.targetArea.path);
    else if (typeof t == "string") { // expecting Target Area ID
        if (!containerAssignmentId) {
            som = this._lookupTargetSOM(t, this._document.targetAreaAssignments);
            som = IccDataUtil.getAbsoluteContainerSomExp(containerSom, som);
        }
        else {
            var containerAssignment = (this._containerAssignmentMap.value(containerAssignmentId))
                ? this._containerAssignmentMap.value(containerAssignmentId)[1] : null;
            // did not find the Field (SOM) yet...look into the Container Layouts
            som = this._lookupTargetSOM(t, containerAssignment.targetAreaAssignments);
            som = IccDataUtil.getAbsoluteContainerSomExp(containerSom, som);
        }
    }

    if (som && this._targetMap.hasKey(som))
        return this._targetMap.value(som);

    throw new Error(CQ.I18n.getMessage("Target Area ") + t + CQ.I18n.getMessage(" is not in letter ") + this._document);
};

/**
 * @private
 * Lookup Target Area SOM given the Target Area ID.
 */
IccData.prototype._lookupTargetSOM = function (targetId, targetAreaAssignments) {
    if (!targetAreaAssignments)
        return null;

    for (var taa, index = 0; index < targetAreaAssignments.length; index++) {
        taa = targetAreaAssignments[index];
        if (taa.targetArea.id === targetId)
            return taa.targetArea.path; // return the SOM, we found it!
    }
    return null;
};


/**
 * Retrieves a map of Form SOM expressions to associated <code>TargetData</code> objects for all content targets found in the letter
 *  (deep into container layouts, if any). A "content target" is one that is assigned modules as content, not a container layout.
 * <p><b>Warning:</b> Form SOMs are not guarranteed to be in the same depth-first order as in the letter's target area assignments collection.</p>
 * @return Map of Form SOM expressions to associated <code>TargetData</code> objects.*/
IccData.prototype.getTargetSoms = function () {
    return this._targetMap;
};

/**
 * Returns true if the letter has content targets.
 *
 * @return*/
IccData.prototype.hasTargets = function () {
    return !this._targetMap.isEmpty;
};

/**
 * Returns an array of <code>TargetData</code> objects for every content target found in the letter (regardless of nesting).
 * <p>Note that it is more efficient to use the <code>forEachTarget()</code> method to iterate the content target set rather than iterating through
 *  this array.</p>
 * <p><b>Warning:</b> Targets are not guarranteed to be in the same depth-first order as in the letter's target area assignments collection.</p>
 *
 * @return*/
IccData.prototype.getTargets = function () {
    return this._targetMap.values;
};

IccData.prototype.forEachTarget = function (context, handler) {
    this._targetMap.forEach(context,
        function (fieldSom, fieldInstance) {
            return handler.call(context, fieldInstance);
        });
};
/**
 * Set the XML data source to use when generating field data for fields that have Data SOM expressions.
 * <p>If a field has a resolved value, that value will always be used. If not and the field maps to a node in this data, the data node's
 *  value will become the field's default value and will be used until the field's value is resolved. If the field does not have a default
 *  value (from this data or otherwise), no data will be generated for the field.</p>
 * <p>The data source specified will also replace all non-ICC Control Data in the generated data so any fields that are ignored or internal
 *  will get their values from this data if they have XFA bindings into it.</p>
 * <p>Setting this property will cause the <code>data</code> and <code>xmlData</code> properties to be updated (and bindings to execute)
 *  if the object isn't muted. It will also cause the root data name to be updated to match the data's root element name.</p>
 * <p><b>Note:</b> Once this property is set to a valid XML object, this class <b>assumes ownership</b> of the object.</p>
 * @param xml The XML Data source to use when generating field data. This is expected to be in the form of
 *  <code>&lt;{rootElement}&gt;...data...&lt;/{rootElement}&gt;</code> (i.e. defines the form's data DOM based on its schema, strictly- or
 *  losely-defined).
 * @throws Error Data source root element must match Data Dictionary Instance Data root element.*/
IccData.prototype.setDataSource = function (xml) {
    //replacing check on qualified name with local name, to resolve error being thrown in case namespace was used and the //root element name space was removed on first reload.
    if (xml && this.schemaInstanceData && xml.localName() != this.schemaInstanceData.localName()) {
        throw new Error(CQ.I18n.getMessage("data source root element '" + xml.localName() + "' must match data dictionary instance data root element '") +
            this.schemaInstanceData.localName() + "'");
    }

    if (xml) {
        // always update root data name to whatever root element name we get in the data source (we assume the letter will have been rendered
        //  with this data source and its data bindings will therefore work with the data's root element name)
        if (this._rootDataName != xml.localName()) {
            this._rootDataName = xml.localName();
            this._updateTargetDataSoms();
            this._updateFieldDataSoms();
            this._updateDynamicTableDataSoms();
        }
    }

    this._xmlDataSource = xml;
    this._dataSourceClone = (this._xmlDataSource ? Form.rte.util.XfaUtil.print(this._xmlDataSource, null) : null); // create XHTML-safe clone
    this._updateFieldDefaultValues();
    this._notifyChange();
};

/**
 * @private
 * Updates the Data SOMs for all targets in the letter based on the current root data name.
 */
IccData.prototype._updateTargetDataSoms = function () {
    this._targetMap.forEach(this,
        function (targetSom, td) {
            td.setDataSomRoot(this._rootDataName);
            return true; // next
        });
};

/**
 * @private
 * Updates the Data SOMs for all fields in the letter based on the current root data name.
 */
IccData.prototype._updateFieldDataSoms = function () {
    this._fieldMap.forEach(this,
        function (fieldSom, fd) {
            fd.setDataSomRoot(this._rootDataName);
            return true; // next
        });
};

/**
 * @private
 * Updates the Data SOMs for all fields in the letter based on the current root data name.
 */
IccData.prototype._updateDynamicTableDataSoms = function () {
    this._dynamicTablesAssignmentMap.forEach(this,
        function (tableRowSom, dynamicTableData) {
            dynamicTableData.setDataSomRoot(this._rootDataName);
            return true; // next
        });
};

/**
 * @private
 * Updates field default values using the current XML Data Source. If the data source is null, nothing is done
 *  (field default values remain what they currently are).
 */
IccData.prototype._updateFieldDefaultValues = function () {
    if (!this._xmlDataSource) // nothing to do -- retain current defaults
        return;

    this._fieldMap.forEach(this,
        function (fieldSom, fd) {
            if (!fd.dataSomExp)
                return true; // skip

            var dataSourceDefault = null;
            var dataSourceFormat = null; // one of MimeType.FORMAT
            var defaultXml = XfaSom.resolveDataSom(fd.dataSomExp, this._xmlDataSource, true); // peek
            if (defaultXml) {
                var richTextXml = Form.rte.util.XmlUtil.getChildElement(defaultXml, XfaXhtml.BODY, false);
                if (richTextXml) {
                    // get the rich text value *inside* the <body> element (necessary for proper concatenation of the field's value
                    //  into a dependent entity such as a variable used in a module) in a safe way, retaining spaceruns
                    dataSourceDefault = IccDataUtil.extractXhtmlContent(Form.rte.util.XfaUtil.print(richTextXml, null));
                    dataSourceFormat = MimeType.FORMAT_RICHTEXT;
                }
                else {
                    // get the value as plain text
                    dataSourceDefault = Form.rte.util.XmlUtil.getNodeText(defaultXml); // encoded XML chars, if any, will be decoded here

                    //evaluate unformatted field value for NumericField to avoid parse error due to alrady applied displayPattern
                    if(IccDataUtil.isNumericField(fd.dataType.toUpperCase())){
                        dataSourceDefault = IccDataUtil.getUnformattedFieldValue(dataSourceDefault, this._document.fieldFormattedMap, fd.formSomExp);
                    }
                    dataSourceFormat = MimeType.FORMAT_PLAINTEXT;
                }
                fd.setDefaultValue(dataSourceDefault, dataSourceFormat); // according to the current XML Data Source...
            }
            if (fd.reloadPending)
                fd.reloadValue(dataSourceDefault, dataSourceFormat); // reload could not be done earlier as dataSom was not available
            return true; // next
        });
};
/**
 * Sets the data used to obtain the Data Dictionary Instance for the letter. This should only be set in the event that the data source
 *  data was not used to obtain the instance (e.g. in a reload scenario where the data source, the IXD, may be different from the Data Dictionary
 *  Instance data if the IXD was modified via a field when the letter was last saved). In the event that both a data source and Data Dictionary
 *  Instance Data (DDID) are specified, the DDID will be used when generating the DDI data; otherwise, the data source will be used.
 * <p><b>Note:</b> Once this property is set to a valid XML object, this class <b>assumes ownership</b> of the object.</p>
 * @param xml The Data Dictionary Instance Data to use when generating the ICC Data. If a data source is specified (<code>dataSource</code> property),
 *  this data is expected to have the same root element. May be null to remove the DDID (which will cause the data source to be used instead, if specified).
 * @throws Error Cannot set Data Dictionary Instance Data because the letter does not use a Data Dictionary.
 * @throws Error Data Dictionary Instance Data root element must match data source root element.
 * @see #dataSource*/
IccData.prototype.setSchemaInstanceData = function (xml) {
    if (!this._schemaInstanceModel)
        throw new Error(CQ.I18n.getMessage("cannot set data dictionary instance data because the letter does not use a data dictionary"));

    //replacing check on qualified name with local name, to resolve error being thrown in case namespace was used and the //root element name space was removed on first reload.
    if (xml && this.dataSource && xml.localName() != this.dataSource.localName()) {
        throw new Error(CQ.I18n.getMessage("data dictionary instance data root element '" + xml.localName() + "' must match data source root element '") +
            this.dataSource.localName() + "'");
    }

    this._ddiDataXml = xml; // null or not
    //the change for bug#3286648.XfaUtil.print used to remove the name space from the _ddiDataXml considering
    //namespaceDeclarations() and not inScopeNamespaces().We now make a copy of this xml and propagate all the
    //root namespace to this copy of xml.
    //the name space list from the original xml
    var nsScopeList = this._ddiDataXml.inScopeNamespaces();
    var _ddiDataXmlCopy = this._ddiDataXml.copy();
    //the name space list of the copied xml
    var ns, _ddiCopyNSList = _ddiDataXmlCopy.namespaceDeclarations();

    for (var index = 0; index < nsScopeList.length; index++) {
        ns = nsScopeList[index];
        //do not include icc namespace in the ddixml
        if (String(ns.prefix).toLowerCase() != "icc") {
            var isDefault = false;
            var usedNamespace = false;
            for (var ns0, index1 = 0; index1 < _ddiCopyNSList.length; index1++) {
                ns0 = _ddiCopyNSList[index1];
                //compare the uri, as copied xml keeps the namespace it was using, as default(with no prefix) i.e xmlns:
                if (ns.uri == ns0.uri) {
                    //avoid adding the default namespace as they cannot be removed by removeNamespace()
                    if (!ns.prefix)
                        isDefault = true;
                    //to avoid adding the namespace again if it exists with the same uri and prefix
                    else if (ns.prefix == ns0.prefix)
                        usedNamespace = true;
                    //remove the namespace and add it afterwards with its actual prefix
                    else
                        _ddiDataXmlCopy.removeNamespace(ns0);
                    break;
                }
            }
            // add the namespace if it was neither default nor a duplicate
            if (!isDefault && !usedNamespace)
                _ddiDataXmlCopy.addNamespace(ns);
        }
    }
    this._ddiDataClone = (this._ddiDataXml ? Form.rte.util.XfaUtil.print(_ddiDataXmlCopy, null) : null); // create XHTML-safe clone
    this._notifyChange();
};

/**
 * @private
 * Generates the actual ICC Data based on the target, field, and variable maps, resolved values, and available binding information.
 *  The bindable <code>data</code> and <code>xmlData</code> class properties are modified to notify any bound listeners.
 */
IccData.prototype._generateData = function (fullMerge) {
    if (this.muted)
        return null;
    if (this.mergePendingTargetData.length > 0) {
        this.mergePendingTargetData.splice(0, this.mergePendingTargetData.length); //empty the pending target merge as we are doing full merge.
    }

    //If FB data bindings are not resolved yet, we can't proceed with generateData. But don't worry, it would be automaticaly called via resolveFbBindings, once FB is connected
    if (!this._fbDataBindingsResolved)
        return null;

    Debug.info("[IccData] _generateData start:");
    this._fullMergeRunning = fullMerge;
    var rootXml = new XML("<" + this._rootDataName + "/>");

    //embedding locale for reverse parsing the default value using pictureFormatApi
    var locale = new XML("<locale></locale>");
    Form.rte.util.XmlUtil.setNodeText(locale, VariableUtils.getLocale());

    if (this._dataSourceClone) { // not null/empty
        var dataSourceCloneXml = Form.rte.util.XfaUtil.load(this._dataSourceClone);
        if (dataSourceCloneXml.localName() == rootXml.localName()) {
            // add a *copy* of the entire dataSource including the root node and its attributes & namespaces.
            rootXml = dataSourceCloneXml;
        }
        else {
            // add a *copy* of the entire data source inside the root, minus its root node (otherwise, when we override values with resolved field values later, we'll modify _xmlDataSource!)
            rootXml.appendChild(dataSourceCloneXml.children(), true); // append *children*, minus the root node (we already have a root)
        }
    }

    rootXml.appendChild(locale);
    var iccXml = null;
    if (this._fullMergeRunning) {
        //If this is full merge, we need all data which are required for reload
        iccXml = new XML("<" + IccDataElem.ICC + " " + IccData.ICCNS + "=\"" + IccData.ICCNS_URI + "\" " + IccData.RENDITION_TYPE + "=\"" + MobileFormBridgeServiceDelegate.PDF_RENDITION_TYPE + "\" " + IccData.ARABIC_TAB + "=\"" + this._flexConfig.arabicMinWidth + "\" " + IccData.ROMAN_TAB + "=\"" + this._flexConfig.romanMinWidth + "\">" +
            "<" + IccDataElem.LETTER + " " + IccDataElem.REF + "=\"" + this._document.id + "\" " + IccDataElem.NAME + "=\"" + this._document.name + "\">" +
            "<" + IccDataElem.LAYOUT + " " + IccDataElem.REF + "=\"" + this._document.form.id + "\"/>" +
            "</" + IccDataElem.LETTER + ">" +
            "</" + IccDataElem.ICC + ">");

        // Inject definition, if any
        if (this._letterDef) {
            var defXML = new XML("<" + IccDataElem.DEFINITION + " " + IccData.ICCNS + "=\"" + IccData.ICCNS_URI + "\"/>");
            Form.rte.util.XmlUtil.setNodeText(defXML, this._letterDef);
            Form.rte.util.XmlUtil.selectFromPath(iccXml, IccDataElem.LETTER).appendChild(defXML, true);
        }

        // NOTE: It's possible we don't have a data source even though we have a DD Instance. The data source will likely be added at a later time so we can't assert that
        //  if _ddInstance isn't null that _xmlDataSource or _ddiDataXml isn't null either.

        if (this._schemaInstanceModel && (this._ddiDataClone || this._dataSourceClone)) {// not null/empty
            // add a *copy* of the entire data source for the DD instance
            var ddXml = new XML("<" + IccDataElem.DATADICTIONARY + " " + IccDataElem.REF + "=\"" + this._document.schemaRef + "\" " + IccData.ICCNS + "=\"" + IccData.ICCNS_URI + "\"/>");
            var instanceXml = new XML("<" + IccDataElem.INSTANCE + " " + IccData.ICCNS + "=\"" + IccData.ICCNS_URI + "\"/>");
            var ddiXml = Form.rte.util.XfaUtil.load(this._ddiDataClone ? this._ddiDataClone : this._dataSourceClone); // XHTML-safe load -- DDID data takes precedence

            // Remove attributes from DDI
            if (ddiXml)
                ddiXml._Attributes = {}; // TODO : Need to find better way of removing attrbitue

            instanceXml.appendChild(ddiXml, true);
            ddXml.appendChild(instanceXml, true);
            Form.rte.util.XmlUtil.selectFromPath(iccXml, IccDataElem.LETTER).appendChild(ddXml, true);
        }

        if (this.attchmentData) { // not null/empty
            var attachXml = new XML("<" + IccDataElem.ATTACHMENT + " " + IccData.ICCNS + "=\"" + IccData.ICCNS_URI + "\"/>");
            this._addContentsToTarget(attachXml, this.attchmentData.contents, [], 0, new CMMap());
            Form.rte.util.XmlUtil.selectFromPath(iccXml, IccDataElem.LETTER).appendChild(attachXml, true);
        }


        var variablesList = this._makeVarList();
        iccXml.appendChild(variablesList, true);
    }
    else {
        //If this is not full merge, we need to generate minimum xml data that can be merged in pdf
        iccXml = new XML("<" + IccDataElem.ICC + " " + IccData.ICCNS + "=\"" + IccData.ICCNS_URI + "\" " + IccData.RENDITION_TYPE + "=\"" + MobileFormBridgeServiceDelegate.PDF_RENDITION_TYPE + "\" " + IccData.ARABIC_TAB + "=\"" + this._flexConfig.arabicMinWidth + "\" " + IccData.ROMAN_TAB + "=\"" + this._flexConfig.romanMinWidth + "\">" +
            "</" + IccDataElem.ICC + ">");
    }

    // generate data for the dynamic table rows
    this._dynamicTablesAssignmentMap.forEach(this,
        function (tableRowSom, dynamicTableData) {
            // set value in IXD if we have a data SOM
            if (dynamicTableData.dynamicRowDataDom) {
                var rowDataSom = dynamicTableData.dynamicRowDataDom;
                var rowTagName = rowDataSom.substr(rowDataSom.lastIndexOf(".") + 1); //name of the row tag
                if (rowTagName.indexOf("[0]") > 0)
                    rowTagName = rowTagName.substring(0, rowTagName.indexOf("[0]"));

                var rowParentDataSom = rowDataSom.substr(0, rowDataSom.lastIndexOf(".")); //dataDom of the row container
                var rowParentXml = XfaSom.resolveDataSom(rowParentDataSom, rootXml, false);
                //TODO: Check if this works correctly.
                delete rowParentXml[rowTagName]; //Remove all the row children from within the container

                /*Case of ICDraftReload, we are reloading with already merged document template.
                  So dynamic table already been merge, resetting the rows to avoid duplicate entries.*/
                if(CCRDefaultActionHandler.prototype.isSavedDraftDocument()){
                    rowParentXml._Children = [];
                    rowParentXml._Value = "";
                }
                if (dynamicTableData.normalizedTableValues) {
                    var normalizedDataRow;
                    for (var index = 0; index < dynamicTableData.normalizedTableValues.length; index++) {
                        normalizedDataRow = dynamicTableData.normalizedTableValues[index];
                        var rowXml = new XML("<" + rowTagName + "/>");
                        for (var i = 0; i < normalizedDataRow.length; i++) {
                            //FieldAssignment anormalizedDataRow elements will have same corresponding index in their respective array
                            var fieldPath = dynamicTableData.fieldAssignments[i].field.path;
                            var fieldName = fieldPath.substr(fieldPath.lastIndexOf(".") + 1);
                            if (fieldName.indexOf("[0]") > 0)
                                fieldName = fieldName.substring(0, fieldName.indexOf("[0]"));
                            var fieldXml = new XML("<" + fieldName + "/>");
                            if (normalizedDataRow[i] != null)
                                Form.rte.util.XmlUtil.setNodeText(fieldXml, normalizedDataRow[i]);
                            rowXml.appendChild(fieldXml, true);
                        }
                        rowParentXml.appendChild(rowXml, true);
                    }
                }
            }
            else
                Debug.warning("skipping data for field " + tableRowSom + ": has no data SOM", null);
            return true; // continue
            //TODO: Anything for reload?
        }
    );

    // generate data for the fields
    var fieldsElemXml = new XML("<" + IccDataElem.FIELDS + " " + IccData.ICCNS + "=\"" + IccData.ICCNS_URI + "\"/>");
    this._fieldMap.forEach(this,
        function (fieldSom, fd) {
            // set value in IXD if we have a data SOM
            if (fd.dataSomExp) {
                var fieldDataXml = XfaSom.resolveDataSom(fd.dataSomExp, rootXml, false); // create if doesn't exist (we already know the field DSOM's root element matches the root data name)
                Form.rte.util.XmlUtil.removeChildren(fieldDataXml); // make sure the field's data node is completely empty before we set its new value

                // at this point, the field's value will be the default value if the field isn't resolved or the bound value is empty; may be empty string if value was explicitly set to empty
                if (MimeType.FORMAT_RICHTEXT == fd.mimeFormat || MimeType.FORMAT_XMLTEXT == fd.mimeFormat) {
                    if (fd.assignment.field.type != Variable.RICHTEXT_TYPE)
                        throw new Error(CQ.I18n.getMessage("expecting rich text field for value in rich text format for ") + fd);

                    // value is XHTML or FlashHTML
                    var fieldValueXml = this._makeXfaRichText(fd.editValue, fd.mimeFormat);
                    fieldDataXml.appendChild(fieldValueXml, true);
                }
                else {
                    // set value as plain text
                    // NOTE: XmlUtil.setNodeText automatically encodes XML characters (except for apostrophes and quotation marks) found in the specified text
                    Form.rte.util.XmlUtil.setNodeText(fieldDataXml, fd.editValue);
                }
            }
            else
                Debug.warning("skipping data for field " + fd.assignment + ": has no data SOM", null);

            if (this._fullMergeRunning) {
                // generate the <icc:field> element

                var fieldXml = new XML("<" + IccDataElem.FIELD + " " + IccDataElem.REF + "=\"" + fd.formSomExp + "\" " + IccData.DATA_SOM + "=\"" + fd.dataSomExp + "\" " + IccData.ICCNS + "=\"" + IccData.ICCNS_URI + "\"/>");
                fieldsElemXml.appendChild(fieldXml, true);

                if (fd.edited)
                    Form.rte.util.XmlUtil.setAttribute(fieldXml, IccDataElem.OVERRIDE, IccDataVal.TRUE);

                if (fd.assignment.bindRef == DataInstance.BINDING_CONTENT) {
                    if (fd.edited)
                        Debug.warning("detected user-edited field assigned to module (not supported) " + fd + ": raw content will be related module's persisted content", null);

                    // generate raw content for the field's module value if the module uses variables
                    var fieldRawXml = this._makeRawXml(fd.assignment.dataModule, fd.assignment.editable);
                    if (fieldRawXml)
                        fieldXml.appendChild(fieldRawXml, true);
                }
                /*
                   1) feed the unformatted value in case of fieldAssignments having displayPicture clause
                   2) multiple checks have been implemented to reduce the xml size.
                   3) Since reverse parsing API is having error we are just saving unformatted value for
                      the plainText fieldType only.
                   4) Set the unformatted value in dataXml only if editValue is not empty.
                 */
                if (fd.assignment && (fd.editValue)) {
                    Form.rte.util.XmlUtil.setAttribute(fieldXml, IccDataElem.UNFORMATTEDVALUE, (fd.unformattedValue || fd.defaultValue));
                }
            }
            return true; // continue
        });

    if (this._fullMergeRunning && fieldsElemXml.elements().length() > 0) {
        var layoutXml = Form.rte.util.XmlUtil.selectFromPath(iccXml, IccDataElem.LETTER, IccDataElem.LAYOUT);
        layoutXml.appendChild(fieldsElemXml, true);
    }

    // generate data for content targets and include resolved module content, if any
    this._targetMap.forEach(this,
        function (targetSom, targetData) {
            if (!targetData.dataNodeName) {
                Debug.warning("skipping data for target " + targetData.assignment + ": has no data SOM");
                return true; // skip
            }
            var targetXml = this._makeTargetXml(targetData);
            if (targetXml) {
                //Target Xml could be null for under resolution target.
                //But we'll keep generating the pdf for merge. Under resolution TargetData would be pushed via incremental merge
                iccXml.appendChild(targetXml, true);
            }

            return true; // continue
        });
    // add the metadata if we have any
    if (this._xmlMeta)
        iccXml.appendChild(this._xmlMeta, true);

    // add the ICC Control Data section to the root data
    rootXml.appendChild(iccXml, true);
    this._fullMergeRunning = false;
    Debug.info("[IccData] _generateData End:");
    return rootXml;
};
IccData.prototype._makeTargetXml = function (targetData) {
    var ref = targetData.formSomExp;
    // handle legacy SOM expressions
    if (ref.indexOf(IccData.MODULE_CONTAINER_SUBFORM) != ref.length - IccData.MODULE_CONTAINER_SUBFORM.length)
        ref = ref + IccData.MODULE_CONTAINER_SUBFORM;
    // IMPORTANT : REF should always be 'formSomExp' since that is what we will use to look up (during reload)
    var targetXml = new XML("<" + IccDataSchema.NSPREFIX + ":" + targetData.dataNodeName + " " + IccDataElem.REF + "=\"" + ref + "\" " + IccData.ICCNS + "=\"" + IccData.ICCNS_URI + "\"/>");
    var result = this._addContentsToTarget(targetXml, targetData.contents, [], 0, new CMMap());
    if (!result) {// Skiping generate XML if any module is in Resloving state
        Debug.warning("[IccData._makeTargetXml] Target data not resolved. Skip generating Xml. Would automatically be resolved at later stage.");
        return null;
    }

    // add the target to the ICC Control Data section only if we generated module content for it
    // (if we were to always add it, we would have to output it as
    //  <icc:{generate_target_name} icc:ref={GUID} xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/" xfa:dataNode="dataGroup"/>
    //  to ensure that the empty data node can properly bind to the XFA subform that represents the target in the layout)
    // if (targetXml.elements().length() > 0)
    if (targetXml.elements("*").length() == 0) { // check if there is any module in the target or not
        // return true; // skip empty content targets

        // (if we were to always add it, we would have to output it as
        //  <icc:{generate_target_name} icc:ref={GUID} xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/" xfa:dataNode="dataGroup"/>
        //  to ensure that the empty data node can properly bind to the XFA subform that represents the target in the layout)

        Form.rte.util.XmlUtil.setAttribute(targetXml, "xmlns:" + XfaSchema.XFANS, XfaData.XFADATANSURI);
        Form.rte.util.XmlUtil.setAttribute(targetXml, "xfa:dataNode", "dataGroup");
    }
    return targetXml;
};


IccData.prototype._makeVarList = function () {
    var variablesXml = new XML("<" + IccDataElem.VARIABLES + " " + IccData.ICCNS + "=\"" + IccData.ICCNS_URI + "\"/>");
    this.forEachVariable(this,
        function (vd) {
            var varXml = this._makeVarXml(vd);
            if (varXml)
                variablesXml.appendChild(varXml, true);
            return true; // next
        });
    return variablesXml;
};
/**
 * @private
 * Adds resolved content to the specified target.
 * @param targetXml Target's XML node in the ICC Data XML object being generated.
 * @param contents Array of <code>ModuleData</code>+ objects to add to the target.
 * @param ancestry Array of <code>Object</code> elements which represent the ancestry from oldest (0) to youngest (n) parent of all
 *  modules contained in <code>contents</code>. Empty array if there is no ancestry for the modules in <code>contents</code> (which should only
 *  be the case when modules in <code>contents</code> are directly selected in the target). Each element has the following properties:
 *  <ul>
 *   <li><code>modData</code> The ancestor module.</li>
 *   <li><code>ident</code> The ancestor's identifier used to differentiate multiple sibling instances of the ancestor.</li>
 *  </ul>
 * @param indent the indentation to be applied on the module(s) being processed currently.
 * @param listToNumberMap the (running) map of a 'List' vs the 'current numbering details' on that list.
 */
IccData.prototype._addContentsToTarget = function (targetXml, contents, ancestry, indent, listToNumberMap) {
    if (ancestry == null)
        throw new Error(CQ.I18n.getMessage("ancestry expected to be valid at the very least")); // assert

    if (contents.length == 0) {
        if (ancestry.length > 0 && ancestry[ancestry.length - 1].modData instanceof ListModuleInstance) {
            // we are processing an empty list -- include empty content for the list
            this._addEntryToTarget(targetXml, null, null, ancestry, 0, null, null);
        }
        return true;
    }

    var contentMap = new CMMap();
    var res, md = null;
    for (var index = 0; index < contents.length; index++) {
        if (contents instanceof Array)
            md = contents[index];
        else
            md = contents.getItemAt(index);
        if (md.resolved) {
            if (contentMap.hasKey(md.moduleId))
                contentMap.assign(md.moduleId, Number(contentMap.value(md.moduleId)) + 1);
            else
                contentMap.assign(md.moduleId, 0);

            if (ancestry && ancestry.length > 0) {
                var parent = ancestry[ancestry.length - 1].modData;
                md.parentNoPageBreak = parent.computedNoPageBreak;
                md.parentKeepWithNext = parent.computedKeepWithNext;
                // If md is first Module in the parent container then propagating the computed Value
                if (md == contents[0])
                    md.parentPageBreakBefore = parent.computedPageBreakBefore;
                else
                    md.parentPageBreakBefore = false;
                // If md is last Module in the parent container then propagating the computed Value
                if (md == contents[contents.length - 1]) {
                    md.parentPageBreakAfter = parent.computedPageBreakAfter;
                    md.computedKeepWithNext = md.parentKeepWithNext;
                }
                else {
                    md.parentPageBreakAfter = false;
                    if (md.parentNoPageBreak)
                        md.computedKeepWithNext = true;
                    else
                        md.computedKeepWithNext = md.keepWithNext;
                }
            }
            else {
                md.parentPageBreakAfter = md.insertPageBreakAfter;
                md.parentPageBreakBefore = md.insertPageBreakBefore;
                md.parentNoPageBreak = md.noPageBreak;
                md.parentKeepWithNext = md.keepWithNext;
            }

            if (md instanceof ListModuleInstance) {
                var listData = md;
                if (!listData.edited) {
                    // add list module to ancestry, in order
                    ancestry.push({modData: listData, ident: Number(contentMap.value(md.moduleId))});
                    // list wasn't edited -- output item data directly into target
                    res = this._addContentsToTarget(targetXml, listData.items, ancestry, indent + listData.indentationLevel, listToNumberMap); // recursive call -- even if listData.items is empty
                    // remove list module from ancestry, in order
                    ancestry.pop();
                    if (!res)// Skiping generate XML if any module is in Resloving state
                        return false;
                    continue;
                }
                // else, list was edited -- output as normal module data
            }
            else if (md instanceof ConditionModuleInstance) {
                var condData = md;
                if (!condData.edited) {// not expecting for Conditions, though
                    // add condition module to ancestry, in order
                    ancestry.push({modData: condData, ident: Number(contentMap.value(md.moduleId))});

                    if (condData.empty) {
                        // add the (empty) result to the target
                        this._addEntryToTarget(targetXml, null, null, ancestry, 0, null, null);
                    }
                    else {
                        // condData wasn't edited -- output item data directly into target
                        res = this._addContentsToTarget(targetXml, condData.selectedItems, ancestry, indent + condData.indentationLevel, listToNumberMap); // recursive call for nested item on the condition
                        if (!res)// Skiping generate XML if any module is in Resloving state
                            return false;
                    }

                    // remove condition module from ancestry, in order
                    ancestry.pop();
                    continue;
                }
                // else, condition was edited -- output as normal module data
            }
            // else, md is either a text or an image module which may or may not be nested inside a list included in the target

            if (!md.isAttachmentContent && (!md.mimeFormat || (DataModuleType.isImageModule(md.assignment.module) && !md.value)))
                throw new Error(CQ.I18n.getMessage("cannot generate data for ") + md.assignment + ": missing MIME format and/or image value"); // assert


            var bullet = null;
            var type = null;
            if (MimeType.formatIsText(md.mimeFormat) && !DataModuleType.isConditionalDataModule(md.assignment.module)) {// bullets are only valid for Text modules
                var bulletXML = IccDataUtil.getXHTMLForBullet(md.value, md.mimeFormat);

                // fontInfo should not be empty -- if it is, it means this module had no content (empty module); in which case, we don't want a bullet for it
                if (bulletXML) {
                    var bulletInfo = this._determineBullet(md, ancestry, listToNumberMap);
                    bullet = bulletInfo.value("bullet");
                    type = bulletInfo.value("type");

                    if (bullet == null) // may be null after determining bulleting based on list properties
                        bulletXML = null; // no bullet needed
                    else if (bulletXML.findFirstElement("span"))// there is a bullet to be applied; so set that
                        bulletXML.findFirstElement("span")[0].setChildren(bullet);
                    else { // there is a bullet to be applied; so set that
                        var sp = bulletXML.attribute("span");
                        sp[0] = sp._Children[0] = new XML();
                        sp.setChildren(bullet);
                    }
                }
            }

            // only supply MIME format if value is not null nor empty string
            this._addEntryContent(this._addEntryToTarget(targetXml, md, md.value ? md.mimeFormat : null, ancestry, indent + md.indentationLevel, bulletXML, type), md, md.value, md.mimeFormat, md.tooltip, md.editable);
        }
        else  // Skiping generate XML if any module is in Resloving state
            return false;
    }
    return true;
};

/**
 * @private
 */
IccData.prototype._determineBullet = function (md, ancestry, listToNumberMap) {
    var bullet = null;
    var type = null;

    var bulletInfo = new CMMap();

    if (ancestry && ancestry.length > 0) {
        var parentList = null;
        var parentListIdent = "";
        var grandParentList = null;
        var grandParentListIdent = "";

        // get the reverse ancestry -- since we need to find the parent List and grand parent list
        var reverseAncestry = ancestry.slice().reverse();

        // walk through (reverse) ancestry , from yougest/parent (0) to oldest (n)
        var ancestor = null;
        for (var index = 0; index < reverseAncestry.length; index++) {
            ancestor = reverseAncestry[index];
            // we found a List
            if (ancestor.modData instanceof ListModuleInstance) {
                // haven't identified the parent yet
                if (parentList == null) {
                    parentList = ancestor.modData;
                    // parentListIdent = parentList.assignment.moduleId + ":" + ancestor.ident;
                }
                else if (grandParentList == null) {// we've identified the parent List, so this must be the grand parent List
                    grandParentList = ancestor.modData;
                    // grandParentListIdent = grandParentList.assignment.moduleId + ":" + ancestor.ident;
                }
            }

            // walk up the hierarchy to uniquely identify the parent and grand-parent list
            if (parentList) {
                if (parentListIdent.length > 0)
                    parentListIdent = parentListIdent + ":" + ancestor.modData.assignment.moduleId + ":" + ancestor.ident;
                else
                    parentListIdent = parentList.assignment.moduleId + ":" + ancestor.ident;
            }

            if (grandParentList) {
                if (grandParentListIdent.length > 0)
                    grandParentListIdent = grandParentListIdent + ":" + ancestor.modData.assignment.moduleId + ":" + ancestor.ident;
                else
                    grandParentListIdent = grandParentList.assignment.moduleId + ":" + ancestor.ident;
            }
        }

        // The current module would not have any bullet/number if either:
        //  the module was not contained inside a List, or
        //  the module was contained inside a List, but the parent's style was PLAIN and (there was no grand parent list or the assignment in the grand parent list was not to 'Ignore List Style'), or
        //  the module was contained inside a List, but the parent's assignment in the grand parent list (of style PLAIN) was 'Ignore List Style'
        //  OR (new addition!!)
        // The item has been specified as 'skip style' in its parent, i.e. do not apply any numbering style, or
        // The parent list's assignment has been specified as 'skip style' in its grand-parent (if any), i.e. do not apply any numbering style on any of the items of that list.
        if ((parentList == null) || (parentList.assignment.module.style == ListModuleInstance.STYLE_PLAIN && (grandParentList == null || !parentList.ignoreListStyle)) ||
            (parentList.assignment.module.style != ListModuleInstance.STYLE_PLAIN && grandParentList != null && grandParentList.assignment.module.style == ListModuleInstance.STYLE_PLAIN && parentList.ignoreListStyle) ||
            (md.skipStyle == true) ||
            (grandParentList && parentList.skipStyle)) {
            bullet = null;
        }
        else {
            // If the Text module has a parent list, but:
            // 1. either, does not have a grand parent (which means the parent list is directly under a Target, possibly
            //	  nested under conditional modules)
            // 2. or, the parent list is included in a grand parent as a nested list, and the nested assignment
            //    is defined as "DO NOT Compound" and "DO NOT Ignore List style",
            // then, use the parent list's own style for the Text module, with the appropriate indentation level.

            if (grandParentList == null || (!parentList.ignoreListStyle && !parentList.compound)) {
                bullet = this._computeBullet(listToNumberMap, parentList.assignment.module, parentListIdent);
                type = parentList.assignment.module.type;
            }
            else {
                var grandParentModule = grandParentList.assignment.module;
                var parentModule = parentList.assignment.module;

                if (parentList.ignoreListStyle) {
                    // which means, ignore the parent List (own) style and use the grand parent list's style
                    bullet = this._computeBullet(listToNumberMap, grandParentList.assignment.module, grandParentListIdent);
                    type = grandParentList.assignment.module.type;
                }
                else if (parentList.compound) {
                    // if the grand parent list happens to have a non-numbered style (SHOULD NOT HAPPEN, but...),
                    // ignore the compounding and use the list's own style
                    if (grandParentModule.style == null ||
                        grandParentModule.style == ListModuleInstance.STYLE_PLAIN ||
                        grandParentModule.style == ListModuleInstance.STYLE_BULLETED) {
                        bullet = this._computeBullet(listToNumberMap, parentModule, parentListIdent);
                        type = parentModule.type;
                    }
                    else {
                        var bulletMap = listToNumberMap.value(parentListIdent); // the current bullet details (index/compound) for the parent list

                        if (!bulletMap) {// if this is the first item in the parent
                            bulletMap = new CMMap();
                            bulletMap.assign(IccData._INDEX_KEY, null);
                            bulletMap.assign(IccData._COMPOUND_KEY, "");
                        }

                        var currentNum = bulletMap.value(IccData._INDEX_KEY); // current/latest number for the parent list
                        var compoundPrefix = bulletMap.value(IccData._COMPOUND_KEY); // current compound prefix for the parent list
                        var prefix = null;
                        var suffix = null;

                        if (parentModule.style == null ||
                            parentModule.style == ListModuleInstance.STYLE_PLAIN ||
                            parentModule.style == ListModuleInstance.STYLE_BULLETED) {
                            // if the parent list is of a plain/bulleted style,
                            // use the grand parent list's style for compounding
                            currentNum = NumberingUtil.getNextNumber(currentNum, grandParentModule.type);
                            type = grandParentModule.type;
                            prefix = grandParentList.assignment.module.prefix;
                            suffix = grandParentList.assignment.module.suffix;
                        }
                        else {
                            currentNum = NumberingUtil.getNextNumber(currentNum, parentModule.type);
                            type = parentModule.type;
                            prefix = parentList.assignment.module.prefix;
                            suffix = parentList.assignment.module.suffix;
                        }

                        // for the first item in the parent, compoundPrefix would be be "" (empty)
                        if (compoundPrefix == "") {
                            var grandParentBulletMap = listToNumberMap.value(grandParentListIdent);

                            // grand parent bullet can still be null, if there was no content/module before the List within the grand parent;
                            // if that's the case then ignore compounding...
                            if (grandParentBulletMap && grandParentBulletMap.value(IccData._INDEX_KEY)) {
                                // The (net) compounding prefix to be applied on the current List's items would be :
                                // <Compound Prefix for the grand-parent List> +  [since the grand parent list may itself be compounded]
                                // <prefix of the grand-parent List> +
                                // <current-number of the grand-parent List> +
                                // <suffix of the grand-parent List>

                                compoundPrefix = grandParentBulletMap.value(IccData._COMPOUND_KEY) + grandParentModule.prefix +
                                    grandParentBulletMap.value(IccData._INDEX_KEY) + grandParentModule.suffix;
                            }
                        }

                        bulletMap.assign(IccData._INDEX_KEY, currentNum);
                        bulletMap.assign(IccData._COMPOUND_KEY, compoundPrefix);

                        // update the map with the new bullet number
                        listToNumberMap.assign(parentListIdent, bulletMap);

                        bullet = compoundPrefix + prefix + currentNum + suffix;
                    }

                }
            }
        }
    }

    bulletInfo.assign("bullet", bullet);
    bulletInfo.assign("type", type);

    return bulletInfo;
};

/**
 * @private
 */
IccData.prototype._computeBullet = function (listToNumberMap, parentList, parentIdent) {
    var bulletStr = null;
    var bulletMap;
    if (parentList.style == null || parentList.style == ListModuleInstance.STYLE_PLAIN) {
        // plain list, so no bulleting to be applied
        return null;
    }
    else if (parentList.style == ListModuleInstance.STYLE_BULLETED) {
        if (parentList.type == ListModuleInstance.TYPE_BULLET_CUSTOM) {
            bulletStr = parentList.bullet ? ContentUtil.unicodeToChar(parentList.bullet) : "";
        } else {
            // set the character as a 'dotted' bullet (unicode)
            bulletStr = IccData.BULLET_UNICODE;
        }
    }
    else if (parentList.style == ListModuleInstance.STYLE_LETTERED || parentList.style == ListModuleInstance.STYLE_NUMBERED) {
        // numbered bullet -- determine the number based on the parent list's style

        bulletMap = listToNumberMap.value(parentIdent); // the current bullet details (index/compound) for the parent list

        if (!bulletMap) { // if this is the first item in the parent
            bulletMap = new CMMap();
            bulletMap.assign(IccData._INDEX_KEY, null);
            bulletMap.assign(IccData._COMPOUND_KEY, "");
        }

        var currentNum = bulletMap.value(IccData._INDEX_KEY); // current/latest number for the parent list

        currentNum = NumberingUtil.getNextNumber(currentNum, parentList.type);

        // update the map with the new bullet number details
        bulletMap.assign(IccData._INDEX_KEY, currentNum);
        listToNumberMap.assign(parentIdent, bulletMap);

        bulletStr = ContentUtil.unicodeToChar(bulletMap.value(IccData._COMPOUND_KEY) + parentList.prefix + currentNum + parentList.suffix);

    } else {
        // TODO: assert error!!
    }
    return bulletStr;
};
/**
 * @private
 * Makes XFA Rich Text (enclosed in &lt;body&gt; element) from the specified value.
 * @param value The XML-based value from which to create the XFA Rich Text.
 * @param mimeFormat One of <code>MimeType.FORMAT_RICHTEXT</code> or <code>MimeType.FORMAT_XMLTEXT</code> constants.
 * @return The XFA Rich Text or null if it couldn't be converted.
 * @throws Error Unsupported MIME format.
 */
IccData.prototype._makeXfaRichText = function (value, mimeFormat) {
    var valueXml = null;
    switch (mimeFormat) {
        case MimeType.FORMAT_RICHTEXT:
            // value is already XHTML but it won't have a <body> root element
            valueXml = IccDataUtil.createXfaRichText(value, this._flexConfig.tabConfig, this.isPdfXmlData);
            break;

        case MimeType.FORMAT_XMLTEXT:
            // value is FlexRT that needs to be converted to XHTML
            //valueXml = IccDataUtil.createXfaRichText(ContentUtil.convertToXhtml(value));
            valueXml = IccDataUtil.createXfaRichText(ContentUtil.convertTlfToXhtml(value), this._flexConfig.tabConfig, this.isPdfXmlData);
            break;

        default:
            throw new Error(CQ.I18n.getMessage("unsupported MIME format: ") + mimeFormat);
            break;
    }

    return valueXml;
};

/**
 * @private
 * Makes a new <code>&lt;icc:var&gt;</code> node for the given variable.
 * @param vd The variable for which to create the XML.
 * @return The <code>&lt;icc:var&gt;</code> node for the given variable.
 */
IccData.prototype._makeVarXml = function (vd) {
    var v = vd.assignment.variable;
    var varXml = new XML("<" + IccDataElem.VAR + " " + IccDataElem.NAME + "=\"" + v.name + "\" " + IccDataElem.PROTECTED + "=\"" + v.protect.toString().toLowerCase() + "\" " + IccData.ICCNS + "=\"" + IccData.ICCNS_URI + "\"/>");

    // make sure the variable type is set as "placeholder" if it should be forced as such; otherwise, set to whatever its type is
    Form.rte.util.XmlUtil.setAttribute(varXml, IccDataElem.TYPE, vd.forcePlaceholder ? Variable.PLACEHOLDER_TYPE.toLowerCase() : v.type.toLowerCase());

    if (v.dataType) // not null/empty -- this property isn't used so make sure it's set
        Form.rte.util.XmlUtil.setAttribute(varXml, IccDataElem.DATATYPE, v.dataType.toLowerCase());

    if (vd.edited)
        Form.rte.util.XmlUtil.setAttribute(varXml, IccDataElem.OVERRIDE, IccDataVal.TRUE); // indicate the value was an override by the user

    // *always* output the value of a variable

    Form.rte.util.XmlUtil.setAttribute(varXml, IccDataElem.CONTENTTYPE, vd.mimeFormat); // specify even if value is empty so we retain the original format
    var editValue = vd.editValue;
    if (editValue) { // not null/empty
        // NOTE: XmlUtil.setNodeText automatically encodes XML characters (except for apostrophes and quotation marks) found in the specified text
        //We are storing the unformatted value in case of variable as well.
        //this is done to be properly reload the data if displayPattern is applied.
        Form.rte.util.XmlUtil.setAttribute(varXml, IccDataElem.UNFORMATTEDVALUE, IccDataUtil.getUnformattedVariableValue(vd)); // specify even if value is empty so we retain the original format
        if (editValue instanceof ArrayCollection || editValue instanceof Array)
            editValue = editValue.toString();
        Form.rte.util.XmlUtil.setNodeText(varXml, IccDataUtil.encodeRawContent(editValue));
    }
    return varXml;
};

/**
 * @private
 * Generates a <code>&lt;icc:parent&gt;</code> element, including <code>/icc:variables/icc:var</code> elements for all of the parent's immediate variables, for
 *  the specified module.
 * @param md The parent module for which to generate the XML. Expected to be a condition or list module.
 * @param parentIdent The parent module's identifier.
 * @return The <code>&lt;icc:parent&gt;</code> element that represents the specified module.
 */
IccData.prototype._makeParentXml = function (md, parentIdent) {
    var parentMod = md.assignment.module;

    var parentXml = new XML("<" + IccDataElem.PARENT + " " + IccDataElem.NAME + "=\"" + parentMod.name + "\" " + IccDataElem.REF + "=\"" + parentMod.id + "\" " + IccDataElem.ID + "=\"" + parentIdent + "\" " + IccData.ICCNS + "=\"" + IccData.ICCNS_URI + "\"/>");

    if (!DataModuleType.isConditionalDataModule(parentMod) && !DataModuleType.isListDataModule(parentMod))
        throw new Error(CQ.I18n.getMessage("parent modules must be either conditions or lists: ") + parentMod);

    Form.rte.util.XmlUtil.setAttribute(parentXml, IccDataElem.TYPE, DataModuleType.isConditionalDataModule(parentMod) ? IccDataVal.CONDITION : IccDataVal.LIST);

    // styling attributes
    //window.relPathMap[md.relPath +"##"+ md.assignment.path] = null;
    //Form.rte.util.XmlUtil.setAttribute(parentXml, IccDataElem.RELPATH, md.relPath + md.assignment.path);
    Form.rte.util.XmlUtil.setAttribute(parentXml, IccDataElem.COMPOUND, md.compound ? IccDataVal.TRUE : IccDataVal.FALSE);
    Form.rte.util.XmlUtil.setAttribute(parentXml, IccDataElem.IGNORESTYLE, md.ignoreListStyle ? IccDataVal.TRUE : IccDataVal.FALSE);
    Form.rte.util.XmlUtil.setAttribute(parentXml, IccDataElem.SKIPSTYLE, (md.skipStyle ? IccDataVal.TRUE : IccDataVal.FALSE));
    Form.rte.util.XmlUtil.setAttribute(parentXml, IccDataElem.EXTRA, (md.extra ? IccDataVal.TRUE : IccDataVal.FALSE));
    Form.rte.util.XmlUtil.setAttribute(parentXml, IccDataElem.ASSIGNEDPOSITION, md.assignedPosition.toString());
    if (md.insertPageBreakAfter)
        Form.rte.util.XmlUtil.setAttribute(parentXml, IccDataElem.PAGEBREAKAFTER, IccDataVal.TRUE);
    if (md.insertPageBreakBefore)
        Form.rte.util.XmlUtil.setAttribute(parentXml, IccDataElem.PAGEBREAKBEFORE, IccDataVal.TRUE);
    if (md.noPageBreak)
        Form.rte.util.XmlUtil.setAttribute(parentXml, IccDataElem.PAGEBREAKBEFORE, IccDataVal.TRUE);
    if (md.keepWithNext && AppConfigInitializer.getInstance().configurationInstance.useKeepWithNext)
        Form.rte.util.XmlUtil.setAttribute(parentXml, IccDataElem.PAGEBREAKBEFORE, IccDataVal.TRUE);

    if (DataModuleType.isListDataModule(parentMod)) {
        Form.rte.util.XmlUtil.setAttribute(parentXml, IccDataElem.MIN, parentMod.min);
        Form.rte.util.XmlUtil.setAttribute(parentXml, IccDataElem.MAX, parentMod.max);
    }

    // add <icc:var> for each of the parent's immediate variables
    if (DataModuleType.hasVariables(parentMod)) {
        var parentVarsXml = new XML("<" + IccDataElem.VARIABLES + " " + IccData.ICCNS + "=\"" + IccData.ICCNS_URI + "\"/>");
        var parentVarList = parentMod.variableList;

        var parentVar = null;

        for (var index = 0; index < parentVarList.length; index++) {
            parentVar = parentVarList[index];
            var varXml = this._makeVarXml(this.getVariableData(parentVar, false)); // we must know each variable already
            if (varXml)
                parentVarsXml.appendChild(varXml, true);
        }

        parentXml.appendChild(parentVarsXml, true);
    }
    return parentXml;
};

/**
 * @private
 * Generates a <code>&lt;icc:raw&gt;</code> element, including any necessary child elements, for the module if it's a text module that is editable
 *  (<i>can</i> be edited but not necessarily edited) or has variables.
 * @param module The module for which to generate a &lt;icc:raw&gt; element. Either <code>ModuleData</code> for a module that was directly accessible or
 *  <code>DataModule</code> for a module that was the result of whitebox resolution (e.g. a condition result).
 * @param editable True if the module is editable; false if not.
 * @return The raw XML element or null if the module did not require raw content to be specified.
 */
IccData.prototype._makeRawXml = function (module, editable) {
    if (!this._fullMergeRunning) //Since it's not a full merge. icc:raw information is redundant/not required.
        return null;
    var rawXml = null;

    // NOTE: if module data, check MIME format, not associated module type (list/condition may have edit/override that is text and uses variables)
    // FORMS-24230: Always emit icc:raw for text modules during full merge so line breaks are preserved in drafts (e.g. for text inside conditions
    // that may not be marked editable but still have user-edited content that loses line breaks when only icc:content/body is used on reload).
    if (DataModuleType.isTBX(module) || module.isText) {
        var usesVars = DataModuleType.isDataModule(module) ? (module.variableList && module.variableList.length > 0) : module.hasActiveVariables;
        // Always emit raw for text modules during full merge to preserve line breaks in drafts (fixes conditional text losing line breaks on reload)
        rawXml = new XML("<" + IccDataElem.RAW + " " + IccData.ICCNS + "=\"" + IccData.ICCNS_URI + "\"/>");
        var rawContentXml = new XML("<" + IccDataElem.CONTENT + " " + IccData.ICCNS + "=\"" + IccData.ICCNS_URI + "\"/>");
        var variablesXml = new XML("<" + IccDataElem.VARIABLES + " " + IccData.ICCNS + "=\"" + IccData.ICCNS_URI + "\"/>");

            var textMod = null;
            if (DataModuleType.isTBX(module)) {
                // use persisted FlashHTML raw content
                textMod = module;
                var tbx = new TBX(textMod);

                Form.rte.util.XmlUtil.setAttribute(rawContentXml, IccDataElem.CONTENTTYPE, MimeType.FORMAT_XMLTEXT); // specify even if raw content is empty so we retain the original format
                if (tbx.tlfText) // not null/empty
                    Form.rte.util.XmlUtil.setNodeText(rawContentXml, IccDataUtil.encodeRawContent(tbx.tlfText));

                var modVar = null;
                var varList = textMod.variableList || [];
                    for (var index = 0; index < varList.length; index++) {
                    modVar = varList[index];
                    // NOTE: we expect to "know" about every variable here even if it's a result of a condition (if so, the variable(s) would've been
                    //  part of the condition's variable list and would be known to us
                    var modVarXml = this._makeVarXml(this.getVariableData(modVar, false));
                    if (modVarXml)
                        variablesXml.appendChild(modVarXml, true);
                }
            }
            else {
                var md = module;
                if (md.edited) {
                    if (!md.rawFormat)
                        throw new Error(CQ.I18n.getMessage("expecting XHTML or FlashHTML format for ") + md); // assert

                    // module was edited and has raw content that differs from its original raw content
                    Form.rte.util.XmlUtil.setAttribute(rawContentXml, IccDataElem.CONTENTTYPE, md.rawFormat); // specify even if raw content is empty so we retain the original format
                    if (md.rawContent) // not null/empty
                        Form.rte.util.XmlUtil.setNodeText(rawContentXml, IccDataUtil.encodeRawContent(md.rawContent));
                }
                else {
                    // use persisted raw FlashHTML since there's no override
                    textMod = md.assignment.module;
                    var tbx = new TBX(textMod);
                    if (tbx == null)
                        throw new Error(CQ.I18n.getMessage("expected text module for module data of type text with no content override")); // assert

                    Form.rte.util.XmlUtil.setAttribute(rawContentXml, IccDataElem.CONTENTTYPE, MimeType.FORMAT_XMLTEXT); // specify even if raw content is empty so we retain the original format
                    if (tbx.tlfText) // not null/empty
                        Form.rte.util.XmlUtil.setNodeText(rawContentXml, IccDataUtil.encodeRawContent(tbx.tlfText));
                }

                // always use the active variables since they will represent only the variables used in the raw content
                //  override (if there is one) or the persisted content
                md.forEachVariable(this,
                    function (vd) {
                        var varXml = this._makeVarXml(vd);
                        if (varXml)
                            variablesXml.appendChild(varXml, true);
                        return true; // next
                    }, true);
            }

            rawXml.appendChild(rawContentXml, true);

            if (variablesXml.elements().length() > 0) // raw content may not contain variables
                rawXml.appendChild(variablesXml, true);

    }
    return rawXml;
};

/**
 * @private
 * Adds the content-related elements to the specified &lt;icc:module&gt; element in a target.
 * @param moduleXml The module XML definition to which the content elements should be added.
 * @param module The module that was the source for the entry. Either <code>ModuleData</code> for a module that was directly accessible or
 *  <code>DataModule</code> for a module that was the result of whitebox resolution (e.g. a condition result).
 * @param value The entry's data.
 * @param mimeFormat The MIME format for the entry (one of <code>MimeType.FORMAT</code>).
 * @param tooltip The tooltip for the entry (usually applies when the entry is an image for accessibility purposes). Can be null/empty if a tooltip
 *  doesn't not apply or is not available.
 * @param editable True if the module is editable; false if not.
 */
IccData.prototype._addEntryContent = function (moduleXml, module, value, mimeFormat, tooltip, editable) {
    if (module == null)
        throw new Error(CQ.I18n.getMessage("invalid module parameter: cannot be null")); // assert

    var type = "";
    if (module.isAttachmentContent)
        type = IccDataVal.ATTACHMENT;
    else
        type = MimeType.formatIsText(mimeFormat) ? IccDataVal.TEXT : IccDataVal.IMAGE;

    if (module.mimeFormat != mimeFormat)
        throw new Error(CQ.I18n.getMessage("module data MIME format '") + module.mimeFormat + CQ.I18n.getMessage("' must match specified MIME format '") + mimeFormat + "'"); // assert

    var contentXml = null;
    var valueXml = null;
    if (type == IccDataVal.TEXT) {
        // format must be either XHTML or FlashHTML
        if (value) // not null/empty (will be empty string if FlashHTML and content was removed completely)
            valueXml = this._makeXfaRichText(value, mimeFormat);
        contentXml = new XML("<" + IccDataElem.CONTENT + " " + IccData.ICCNS + "=\"" + IccData.ICCNS_URI + "\"/>");
        if (valueXml != null)
            contentXml.appendChild(valueXml, true);
    }
    else { // image
        // load image content as a simple text node
        if (!value) // null/empty
            throw new Error(CQ.I18n.getMessage("unexpected empty content for image/content module ") + module);

        valueXml = Form.rte.util.XfaUtil.load(value);

        // define content node to include image's mime type
        contentXml = new XML("<" + IccDataElem.CONTENT + " " + IccData.ICCNS + "=\"" + IccData.ICCNS_URI + "\" " + "xmlns:" + XfaSchema.XFANS + "=\"" + XfaData.XFADATANSURI + "\" " + XfaSchema.XFANS + ":" + XfaAtt.CONTENTTYPE + "=\"" + mimeFormat + "\">" + valueXml.toXMLString() + "</" + IccDataElem.CONTENT + ">")
    }


    if (valueXml) {
        var nsXhtml = new Namespace("", XfaXhtml.XHTMLNSURI);
        valueXml.setNamespace(nsXhtml);
    }

    moduleXml.insertChildAfter(null, contentXml); // insert as first child inside <icc:module>

    // add config if we have a tooltip
    var configXml = null;
    if (tooltip) {
        configXml =
            new XML("<" + IccDataElem.CONFIG + " " + IccData.ICCNS + "=\"" + IccData.ICCNS_URI + "\">" +
                "<" + IccDataElem.ACCESSIBILITY + ">" +
                "<" + IccDataElem.TOOLTIP + ">" + tooltip + "</" + IccDataElem.TOOLTIP + ">" +
                "</" + IccDataElem.ACCESSIBILITY + ">" +
                "</" + IccDataElem.CONFIG + ">");
        moduleXml.insertChildAfter(contentXml, configXml); // insert after <icc:content>
    }

    // add raw content if module is a text module that uses variables (at this time, only text modules have content that might have
    //  variable tokens in it) and/or its value was edited (overridden) by the user
    var rawXml = this._makeRawXml(module, editable);
    if (rawXml != null) {
        if (IccDataVal.TEXT != type)
            throw new Error(CQ.I18n.getMessage("expected type to be text for a text module")); // assert
        moduleXml.insertChildAfter(configXml ? configXml : contentXml, rawXml); // insert after <icc:config> if exists; after <icc:content> otherwise
    }
};

/**
 * @private
 * Adds a data entry in the target. The entry does not contain any content-related elements. Use <code>_addEntryContent()</code> for that.
 * @param targetXml Target's XML node in the ICC Data XML object being generated.
 * @param module The module that was the source for the entry. Either <code>ModuleData</code> for a module that was directly accessible or
 *  <code>DataModule</code> for a module that was the result of whitebox resolution (e.g. a condition result). Null if the entry is empty (i.e. represents
 *  a condition direct/nested in the target that has no results).
 * @param mimeFormat The MIME format for the entry (one of <code>MimeType.FORMAT</code>) if the entry has content that is non-empty. Ignored if
 *  <code>module</code> is null. If the entry's content is empty, the MIME format should be null.
 * @param ancestry Array of <code>Object</code> elements which represent the ancestry from oldest (0) to youngest (n) parent of all
 *  modules contained in <code>contents</code>. Null or empty array if there is no ancestry for the modules in <code>contents</code> (which should only
 *  be the case when modules in <code>contents</code> are directly selected in the target). Each element has the following properties:
 *  <ul>
 *   <li><code>modData</code> The ancestor module.</li>
 *   <li><code>ident</code> The ancestor's identifier used to differentiate multiple sibling instances of the ancestor.</li>
 *  </ul>
 * @param indent The indentation to be applied for the current <code>module</code> in its target. This will always be an absolute indentation value. The relative values
 * would be resolved to absolute by virtue of a recursive call to this method.
 * @param bulletXHTML The bullet character XHTML to be applied against the <code>module</code>.
 * @param bulletType The bulleting type (TYPE_ROMAN_UPPER, TYPE_ROMAN_LOWER, etc.) to be applied against the <code>module</code>.
 * @return The generated &lt;icc:module&gt; element (appended to <code>targetXml</code). Note that this element does not contain any content-related elements.
 * @see #_addEntryContent()
 */
IccData.prototype._addEntryToTarget = function (targetXml, module, mimeFormat, ancestry, indent, bulletXHTML, bulletType) {
    indent = indent !== undefined ? indent : 0;
    var moduleXml = null;
    if (module != null) {
        if (module instanceof ModuleInstance && mimeFormat) {
            if (module.mimeFormat != mimeFormat)
                throw new Error(CQ.I18n.getMessage("module data MIME format '") + module.mimeFormat + CQ.I18n.getMessage("' must match specified MIME format '") + mimeFormat + "'"); // assert
        }

        // always specify @type but only give it a value if the mime format is specified
        // mime format will be null/empty if module has empty value, in which case we don't set a specific type otherwise there will still be output in the PDF
        //  (subform instance will be created even though content is empty)
        var type = "";
        if (module.isAttachmentContent)
            type = IccDataVal.ATTACHMENT;
        else if (mimeFormat)
            type = MimeType.formatIsText(mimeFormat) ? IccDataVal.TEXT : IccDataVal.IMAGE;

        var moduleName = module.name;
        var moduleId = DataModuleType.isDataModule(module) ? module.id : module.moduleId;
        var editable = module.editable && !(module instanceof ImageModuleInstance);
        moduleXml = new XML("<" + IccDataElem.MODULE + " " + IccDataElem.NAME + "=\"" + moduleName + "\" " + IccDataElem.EDITABLE + "=\"" + editable + "\" " + IccDataElem.CHART + "=\"" + module.isChart + "\" " + IccDataElem.PATH + "=\"" + module.hierarchyPath + "\" " + IccDataElem.REF + "=\"" + moduleId + "\" " + IccDataElem.TYPE + "=\"" + type + "\" " + IccDataElem.WIDTH + "=\"" + module.moduleWidth + "\" " + IccDataElem.HEIGHT + "=\"" + module.moduleHeight + "\" " + IccData.ICCNS + "=\"" + IccData.ICCNS_URI + "\"/>");


        // add relPath
        window.relPathMap = window.relPathMap || {};
        window.relPathMap[module.relPath] = null;
        Form.rte.util.XmlUtil.setAttribute(moduleXml, IccDataElem.RELPATH, module.relPath);

        // add @icc:extra if the module is an extra content in its container.
        if (module.extra)
            Form.rte.util.XmlUtil.setAttribute(moduleXml, IccDataElem.EXTRA, IccDataVal.TRUE);

        // only add @icc:override if the module was edited (which can only happen if we have module data)
        if (module.edited)
            Form.rte.util.XmlUtil.setAttribute(moduleXml, IccDataElem.OVERRIDE, IccDataVal.TRUE);

        // only add @icc:skipStyle if the module style/bullet was skipped
        if (module.skipStyle)
            Form.rte.util.XmlUtil.setAttribute(moduleXml, IccDataElem.SKIPSTYLE, IccDataVal.TRUE);

        // only add @icc:fileName if the module is Attachment
        if (module.isAttachmentContent) {
            var attachContent = module.assignment.module;
            Form.rte.util.XmlUtil.setAttribute(moduleXml, IccDataElem.FILENAME, attachContent.fileName);
        }
        // add @icc:assignedPosition
        Form.rte.util.XmlUtil.setAttribute(moduleXml, IccDataElem.ASSIGNEDPOSITION, module.assignedPosition.toString());

        // add @icc:pageBreakBefore
        if (module.insertPageBreakBefore)
            Form.rte.util.XmlUtil.setAttribute(moduleXml, IccDataElem.PAGEBREAKBEFORE, module.insertPageBreakBefore.toString());

        // add @icc:pageBreakAfter
        if (module.insertPageBreakAfter)
            Form.rte.util.XmlUtil.setAttribute(moduleXml, IccDataElem.PAGEBREAKAFTER, module.insertPageBreakAfter.toString());

        // add @icc:noPageBreak
        if (module.noPageBreak)
            Form.rte.util.XmlUtil.setAttribute(moduleXml, IccDataElem.NOPAGEBREAK, module.noPageBreak.toString());

        // add @icc:keepWithNext
        if (module.keepWithNext)
            Form.rte.util.XmlUtil.setAttribute(moduleXml, IccDataElem.KEEPWITHNEXT, module.keepWithNext.toString());


        // Adding @icc:pageLayout tag with attributes icc:pageBreakAfter, icc:pageBreakBefore
        var pageLayoutXML = null;
        if (module instanceof ModuleInstance) {
            pageLayoutXML = new XML("<" + IccDataElem.PAGELAYOUT + " " + IccData.ICCNS + "=\"" + IccData.ICCNS_URI + "\"/>");
            Form.rte.util.XmlUtil.setAttribute(pageLayoutXML, IccDataElem.PAGEBREAKAFTER, module.computedPageBreakAfter.toString());
            Form.rte.util.XmlUtil.setAttribute(pageLayoutXML, IccDataElem.PAGEBREAKBEFORE, module.computedPageBreakBefore.toString());
            Form.rte.util.XmlUtil.setAttribute(pageLayoutXML, IccDataElem.NOPAGEBREAK, module.computedNoPageBreak.toString());
            Form.rte.util.XmlUtil.setAttribute(pageLayoutXML, IccDataElem.KEEPWITHNEXT, module.computedKeepWithNext.toString());
            moduleXml.appendChild(pageLayoutXML, true);
        }

    }
    else {
        // must specify attributes even if they don't have values (XFA data binding) -- no need for @icc:override
        moduleXml = new XML("<" + IccDataElem.MODULE + " " + IccDataElem.NAME + "='' " + IccDataElem.REF + "='' " + IccDataElem.TYPE + "='' " + IccData.ICCNS + "=\"" + IccData.ICCNS_URI + "\"/>");
    }


    // add origin if we have ancestry and we are running in full merge mode
    if (ancestry && ancestry.length > 0 && this._fullMergeRunning) {
        // create <icc:origin>
        var originXml = new XML("<" + IccDataElem.ORIGIN + " " + IccData.ICCNS + "=\"" + IccData.ICCNS_URI + "\"/>");
        var parentXml = null;

        // append ancestry in order, from oldest (0) to youngest (n) parent
        var ancestor = null;
        for (var index = 0; index < ancestry.length; index++) {
            ancestor = ancestry[index];
            parentXml = this._makeParentXml(ancestor.modData, ancestor.ident);
            //populate the relPath of parentContainer if module is empty.[CQ-4305272]
            if (module == null && ancestor.modData.relPath) {
                Form.rte.util.XmlUtil.setAttribute(parentXml, IccDataElem.RELPATH, ancestor.modData.relPath);
            }
            if (parentXml)
                originXml.appendChild(parentXml, true);
        }
        moduleXml.appendChild(originXml, true);
    }


    // _______________________ APPLY FORMATTING ____________________________ //

    // create <icc:format>
    var formatXml = new XML("<" + IccDataElem.FORMAT + " " + IccData.ICCNS + "=\"" + IccData.ICCNS_URI + "\"/>");
    // create <icc:indent>
    var indentXml = new XML("<" + IccDataElem.INDENT + " " + IccDataElem.LEVEL + "=\"" + indent + "\" " + IccDataElem.VALUE + "=\"" + (indent * this._flexConfig.indent) + "mm\" " + IccData.ICCNS + "=\"" + IccData.ICCNS_URI + "\"/>");
    formatXml.appendChild(indentXml, true);

    if (bulletXHTML) {
        // create <icc:bullet>
        // fallback on type as Arabic, if one is not determined (should not happen though)
        var bulletXml = new XML("<" + IccDataElem.BULLET + " " + IccDataElem.TYPE + "=\"" + (bulletType == null ? ListModuleInstance.TYPE_NUMBER_ARABIC : bulletType) + "\" " + IccData.ICCNS + "=\"" + IccData.ICCNS_URI + "\"/>");
        bulletXml.appendChild(bulletXHTML, true);

        formatXml.appendChild(bulletXml, true);
    }

    // add format to the module
    moduleXml.appendChild(formatXml, true);

    // _______________________ DONE FORMATTING ____________________________ //

    // add the module to the target
    targetXml.appendChild(moduleXml, true);
    return moduleXml;
};

IccData.prototype._setRootDataName = function (somExp) {
    if (!somExp)
        return;
    // expecting xfa[0].template[0].{rootDataName}[0]...
    var prefix = "xfa[0].template[0].";
    if (somExp.indexOf(prefix) == 0) {
        var start = prefix.length;
        var end = somExp.indexOf("[0]", start);
        if (end > start)
            this._rootDataName = somExp.substring(start, end);
    }
};

IccData.prototype._notifyChange = function () {
    if (!this.muted)
        this.trigger(new CMEvent(CMEvent.CHANGE)); // notify bound listeners of changes to data and xmlData properties
};

IccData.prototype.updateVariableAssignment = function (assignmentVO) {
    if (this._schemaInstanceModel == null || this._schemaInstanceModel.schema == null)
        return;
    if (assignmentVO.variable != null && Variable.isSchemaType(assignmentVO.variable.type)) {   //Removed condition to check protect for Bug Fix : CQ-50398
        var property = this._schemaInstanceModel.schemaService.getProperty(assignmentVO.variable.name);
        if (property == null)
            return;
        assignmentVO.toolTip = this._schemaInstanceModel.getLocalizedPropertyValue(property, "description", property.description);
        if (property.displayName != null && String(property.displayName).trim() != "")
            assignmentVO.caption = this._schemaInstanceModel.getLocalizedPropertyValue(property, "displayName", property.displayName);
        else
            assignmentVO.caption = property.referenceName;
        assignmentVO.variable.subType = property.elementSubType;
        assignmentVO.variable.valueSet = property.valueSet;
    }
};
IccData.prototype.createNode = function (name, attributes) {
    var node = document.createElement(name);
    if (attributes) {
        for (var name in attributes)
            node.setAttribute(name, attributes[name]);
    }
};
IccData.prototype.dataSomFunction = function (dataSomObject) {
    if (dataSomObject && dataSomObject.hasOwnProperty("DataSOM")) {
        if (this._rootDataName)
            return IccDataUtil.changeDataSomExpRoot(dataSomObject.DataSOM, this._rootDataName);
        else
            return dataSomObject.DataSOM;
    }
    return null;
};
IccData.prototype.defaultValueFunction = function (dataSomObject) {
    if (dataSomObject && dataSomObject.hasOwnProperty("DefaultValue"))
        return dataSomObject.DefaultValue;
    return null;
};
IccData.defineProps({
    data: {
        "get": function () {
            var xml = this.xmlData;
            if (xml) {
                var xmlStr = Form.rte.util.XfaUtil.print(xml, {pretty: true});
                return xmlStr;
            }
            else
                return null;
        }
    },

    minMergeData: {
        "get": function () {
            if (this.muted)
                return null;
            else {
                var xml = this._generateData(false);
                return xml ? Form.rte.util.XfaUtil.print(xml, {pretty: true}) : null;
            }
        }
    },
    xmlData: {
        "get": function () {
            return this.muted ? null : this._generateData(true);
        }
    },
    schemaInstanceModel: {
        "get": function () {
            return this._schemaInstanceModel;
        }
    },
    schemaService: {
        "get": function () {
            return this._schemaInstanceModel.schemaService;
        }
    },
    rootDataName: {
        "get": function () {
            return this._rootDataName;
        }
    },
    document: {
        "get": function () {
            return this._document;
        }
    },
    dataSource: {
        "get": function () {
            return this._xmlDataSource;
        }
    },
    schemaInstanceData: {
        "get": function () {
            if (!this._schemaInstanceModel)
                return null;

            if (this._ddiDataXml)
                return this._ddiDataXml;

            return this.dataSource; // return whatever this is
        }
    },

    enableIncrementalMerge: {
        "get": function () {
            return this._enableIncrementalMerge;
        },
        "set": function (value) {
            if (this._enableIncrementalMerge != value) {
                this._enableIncrementalMerge = value;
                if (this._enableIncrementalMerge) {
                    Deferred.doLater(this._mergeTargetData, null, this);
                    if (this.mergePendingTargetData.length > 0)
                        this.trigger(new LetterDataChangeEvent(LetterDataChangeEvent.LETTER_DATA_CHANGE_START, null, LetterDataChangeEvent.CHANGETYPE_TARGETAREA));
                }
            }
        }
    },
    muted: {
        "get": function () {
            return this._muted;
        },
        "set": function (mute) {
            this._muted = mute;

            // (re-)generate data immediately when un-muted
            if (!this._muted)
                this._notifyChange();
        }
    },
    xmlMetadata: {
        "get": function () {
            return this._xmlMeta;
        },
        "set": function (xml) {
            if (xml && Form.rte.util.XmlUtil.qualifiedName(xml) == IccDataElem.META)
                this._xmlMeta = xml;
            else
                this._xmlMeta = null;
        }
    },
    taFieldOrderMap: {
        "get": function () {
            return this._taFieldOrderMap;
        },
        "set": function (value) {
            if (this._taFieldOrderMap == value)
                return;
            this._taFieldOrderMap = value;
        }
    }
});

/**  Unicode for a BULLET character. */
IccData.BULLET_UNICODE = "\u2022";
IccData.MODULE_CONTAINER_SUBFORM = ".ModuleContainer[0]";
IccData._COMPOUND_KEY = "compoundPrefix";
IccData._INDEX_KEY = "currentIndex";
IccData.ARABIC_TAB = "arabicTab";
IccData.RENDITION_TYPE = "renditionType";
IccData.ROMAN_TAB = "romanTab";
IccData.ICCNS = "xmlns:" + IccDataSchema.NSPREFIX;
IccData.ICCNS_URI = IccDataSchema.NSURI;
IccData.DATA_SOM = "dataSOM";
IccData.ISO_DATE_FORMAT = {dateFormat: "yyyy-MM-dd"};

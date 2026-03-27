package com.fofo.aem.forms.core.service.impl;

import com.adobe.aemfd.docmanager.Document;
import com.adobe.fd.docassurance.client.api.DocAssuranceService;
import com.adobe.fd.docassurance.client.api.DocAssuranceServiceOperationTypes;
import com.adobe.fd.docassurance.client.api.EncryptionOptions;
import com.adobe.fd.docassurance.client.api.ReaderExtensionOptions;
import com.adobe.fd.encryption.client.PasswordEncryptionCompatability;
import com.adobe.fd.encryption.client.PasswordEncryptionOption;
import com.adobe.fd.encryption.client.PasswordEncryptionOptionSpec;
import com.adobe.fd.encryption.client.PasswordEncryptionPermission;
import com.adobe.fd.forms.api.AcrobatVersion;
import com.adobe.fd.forms.api.FormsService;
import com.adobe.fd.forms.api.FormsServiceException;
import com.adobe.fd.forms.api.PDFFormRenderOptions;
import com.adobe.fd.forms.api.RenderAtClient;
import com.adobe.fd.readerextensions.client.ReaderExtensionsOptionSpec;
import com.adobe.fd.readerextensions.client.UsageRights;
import com.adobe.fd.signatures.pdf.inputs.UnlockOptions;
import com.fofo.aem.forms.core.configuration.DocSvcConfiguration;
import com.fofo.aem.forms.core.service.DocumentServices;
import com.fofo.aem.forms.core.service.GetFormListConfiguration;
import com.fofo.aem.forms.core.service.GetResolver;
import org.apache.commons.io.FilenameUtils;
import org.osgi.service.component.annotations.*;
import org.osgi.service.metatype.annotations.Designate;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.xml.sax.InputSource;
import org.xml.sax.SAXException;

import javax.xml.parsers.DocumentBuilder;
import javax.xml.parsers.DocumentBuilderFactory;
import javax.xml.parsers.ParserConfigurationException;
import javax.xml.transform.TransformerFactory;
import javax.xml.transform.dom.DOMSource;
import javax.xml.transform.stream.StreamResult;
import java.io.*;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Objects;


@Component(
        service = {DocumentServices.class}
)
@Designate(ocd = DocSvcConfiguration.class)
public class DocumentServicesImpl implements DocumentServices {

    @Reference
    FormsService formsService;

    @Reference
    GetResolver getResolver;

    @Reference
    DocAssuranceService docAssuranceService;

    @Reference
    GetFormListConfiguration getFormListConfiguration;

    private static final Logger log = LoggerFactory.getLogger(DocumentServicesImpl.class);

    private DocSvcConfiguration docConfig;

    public DocumentServicesImpl() {
    }

    @Activate
    public void activate(DocSvcConfiguration config)
    {
        this.docConfig = config;
    }

    @Override
    public Document renderAndExtendXdp(String xdpPath, String userXML) {

        log.info("Inside renderAndExtendXdp{}", xdpPath);
        // TODO Auto-generated method stub
        log.info("In renderAndExtend xdp the alias is {}", docConfig.ReaderExtensionAlias());
        String xdpName = FilenameUtils.getBaseName(xdpPath);
        log.debug("xdpName is {}", xdpName);
        String[] list = getFormListConfiguration.getExDataList();
        boolean found = Arrays.asList(list).contains(xdpName);
        log.debug("Is xdpName in list? {}", found);
        PDFFormRenderOptions renderOptions = new PDFFormRenderOptions();
        renderOptions.setAcrobatVersion(AcrobatVersion.Acrobat_11);
        if (found){
            renderOptions.setRenderAtClient(RenderAtClient.NO);
        }else {
            renderOptions.setRenderAtClient(RenderAtClient.YES);
        }
        log.info("userXML is {}", userXML);
        Document xdpRenderedAsPDF;

        try {
            if (userXML!=null && !userXML.isEmpty()) {
                org.w3c.dom.Document xmlDataDoc = this.w3cDocumentFromStrng(userXML);
                Document xmlDataDocument = this.orgw3cDocumentToAEMFDDocument(xmlDataDoc);
                xdpRenderedAsPDF = formsService.renderPDFForm("crx://" + xdpPath, xmlDataDocument, renderOptions);
            } else {
                xdpRenderedAsPDF = formsService.renderPDFForm("crx://" + xdpPath, null, renderOptions);
            }
            ReaderExtensionsOptionSpec reOptionsSpec = getReaderExtensionsOptionSpec();
            UnlockOptions unlockOptions = null;
            ReaderExtensionOptions reOptions = ReaderExtensionOptions.getInstance();
            reOptions.setCredentialAlias(docConfig.ReaderExtensionAlias());
            log.debug("set the credential");
            reOptions.setResourceResolver(getResolver.getFormsServiceResolver());
            reOptions.setReOptions(reOptionsSpec);
            log.debug("set the resourceResolver and re spec");
            xdpRenderedAsPDF = docAssuranceService.secureDocument(xdpRenderedAsPDF, getPassEncryptionOptions(), null, reOptions,
                    unlockOptions);
            return xdpRenderedAsPDF;
        } catch (FormsServiceException e) {
            log.error("FormsServiceException", e);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
        return null;
    }

    private ReaderExtensionsOptionSpec getReaderExtensionsOptionSpec() {
        UsageRights usageRights = new UsageRights();
        usageRights.setEnabledBarcodeDecoding(docConfig.BarcodeDecoding());
        usageRights.setEnabledFormFillIn(docConfig.FormFill());
        usageRights.setEnabledComments(docConfig.Commenting());
        usageRights.setEnabledEmbeddedFiles(docConfig.EmbeddingFiles());
        usageRights.setEnabledDigitalSignatures(docConfig.DigitalSignatures());
        usageRights.setEnabledFormDataImportExport(docConfig.FormDataExportImport());
        return new ReaderExtensionsOptionSpec(usageRights, "Sample ARES");
    }

    private EncryptionOptions getPassEncryptionOptions(){

        //Create an instance of EncryptionOptions
        EncryptionOptions encryptionOptions = EncryptionOptions.getInstance();

        //Create a PasswordEncryptionOptionSpec object that stores encryption run-time values
        PasswordEncryptionOptionSpec passSpec = new PasswordEncryptionOptionSpec();

        //Specify the PDF document resource to encrypt
        passSpec.setEncryptOption(PasswordEncryptionOption.ALL);

        //Specify the permission associated with the password
        //These permissions enable data to be extracted from a password
        //protected PDF form
        List<PasswordEncryptionPermission> encrypPermissions = new ArrayList<PasswordEncryptionPermission>();
        encrypPermissions.add(PasswordEncryptionPermission.PASSWORD_EDIT_ADD);
        encrypPermissions.add(PasswordEncryptionPermission.PASSWORD_PRINT_HIGH);
        encrypPermissions.add(PasswordEncryptionPermission.PASSWORD_EDIT_FORM_FILL);
        encrypPermissions.add(PasswordEncryptionPermission.PASSWORD_EDIT_EXTRACT);
        passSpec.setPermissionsRequested(encrypPermissions);

        //Specify the Acrobat version
        passSpec.setCompatability(PasswordEncryptionCompatability.ACRO_7);

        //Specify the password values
        passSpec.setPermissionPassword(docConfig.PermissionPassword());

        //Set the encryption type to Password Encryption
        encryptionOptions.setEncryptionType(DocAssuranceServiceOperationTypes.ENCRYPT_WITH_PASSWORD);
        encryptionOptions.setPasswordEncryptionOptionSpec(passSpec);

        return encryptionOptions;
    }

    public org.w3c.dom.Document w3cDocumentFromStrng(String xmlString) {
        try {
            log.debug("Inside w3cDocumentFromString{}", xmlString);
            DocumentBuilder db = DocumentBuilderFactory.newInstance().newDocumentBuilder();
            InputSource is = new InputSource();
            is.setCharacterStream(new StringReader(xmlString));
            return db.parse(is);
        } catch (ParserConfigurationException | SAXException | IOException var4) {
            log.error("ParserConfigurationException", var4);
        }

        return null;
    }

    public Document orgw3cDocumentToAEMFDDocument(org.w3c.dom.Document xmlDocument) {
        ByteArrayOutputStream outputStream = new ByteArrayOutputStream();
        DOMSource source = new DOMSource(xmlDocument);
        log.debug("$$$$In orgW3CDocumentToAEMFDDocument method");
        StreamResult outputTarget = new StreamResult(outputStream);

        try {
            TransformerFactory.newInstance().newTransformer().transform(source, outputTarget);
            InputStream is1 = new ByteArrayInputStream(outputStream.toByteArray());
            Document xmlAEMFDDocument = new Document(is1);
            if (log.isDebugEnabled()) {
                xmlAEMFDDocument.copyToFile(new File("dataxmldocument.xml"));
            }

            return xmlAEMFDDocument;
        } catch (Exception var7) {
            log.error("Error in generating ddx {}", var7.getMessage());
            return null;
        }
    }

}

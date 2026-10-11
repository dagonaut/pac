import { Stack, type StackProps } from 'aws-cdk-lib';
import { Certificate, CertificateValidation, type ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import { HostedZone } from 'aws-cdk-lib/aws-route53';
import type { Construct } from 'constructs';

export interface CertStackProps extends StackProps {
  zoneName: string;
  domainNames: string[];
}

/** CloudFront only accepts certificates from us-east-1, so this stack always lives there. */
export class CertStack extends Stack {
  readonly certificate: ICertificate;

  constructor(scope: Construct, id: string, props: CertStackProps) {
    super(scope, id, props);
    const zone = HostedZone.fromLookup(this, 'Zone', { domainName: props.zoneName });
    const [first, ...rest] = props.domainNames;
    this.certificate = new Certificate(this, 'Cert', {
      domainName: first,
      subjectAlternativeNames: rest,
      validation: CertificateValidation.fromDns(zone),
    });
  }
}

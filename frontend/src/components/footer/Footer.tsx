import {
  Anchor,
  Badge,
  Box as MFooter,
  Group,
  SimpleGrid,
  Text,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import useConfig from "../../hooks/config.hook";
import useTranslate from "../../hooks/useTranslate.hook";
import { safeHttpUrl } from "../../utils/safe-url.util";

const Footer = () => {
  const t = useTranslate();
  const config = useConfig();
  const hasImprint = !!(
    config.get("legal.imprintUrl") || config.get("legal.imprintText")
  );
  const hasPrivacy = !!(
    config.get("legal.privacyPolicyUrl") ||
    config.get("legal.privacyPolicyText")
  );
  const imprintUrl =
    (!config.get("legal.imprintText") &&
      safeHttpUrl(config.get("legal.imprintUrl"))) ||
    "/imprint";
  const privacyUrl =
    (!config.get("legal.privacyPolicyText") &&
      safeHttpUrl(config.get("legal.privacyPolicyUrl"))) ||
    "/privacy";

  const isMobile = useMediaQuery("(max-width: 700px)");

  // Identificação do sistema com a versão resolvida em build-time pelo git
  // (next.config.js). Centraliza numa única função para os dois layouts.
  const systemId = (align: "center" | "left") => (
    <Group gap={6} justify={align === "left" ? "flex-start" : "center"} wrap="wrap">
      <Text size="xs" c="dimmed" component="span">
        SIGAV
      </Text>
      <Badge
        size="xs"
        variant="light"
        color="blue"
        aria-label="Versão do sistema"
        style={{ textTransform: "none", letterSpacing: 0 }}
      >
        {process.env.VERSION || "dev"}
      </Badge>
    </Group>
  );

  return (
    <MFooter component="footer" h="auto" py={6} px="xl" style={{ zIndex: 100 }}>
      {!config.get("legal.enabled") && (
        <>
          {systemId("center")}
          <Text size="xs" c="dimmed" ta="center">
            Secretaria Municipal de Defesa Social de Londrina
          </Text>
        </>
      )}
      {config.get("legal.enabled") && (
        <SimpleGrid cols={isMobile ? 2 : 3} m={0}>
          {!isMobile && <div></div>}
          <div>
            {systemId(isMobile ? "left" : "center")}
            <Text size="xs" c="dimmed" ta={isMobile ? "left" : "center"}>
              Secretaria Municipal de Defesa Social de Londrina
            </Text>
          </div>
          <div>
            <Text size="xs" c="dimmed" ta="right">
              {hasImprint && (
                <Anchor size="xs" href={imprintUrl}>
                  {t("imprint.title")}
                </Anchor>
              )}
              {hasImprint && hasPrivacy && " • "}
              {hasPrivacy && (
                <Anchor size="xs" href={privacyUrl}>
                  {t("privacy.title")}
                </Anchor>
              )}
            </Text>
          </div>
        </SimpleGrid>
      )}
    </MFooter>
  );
};

export default Footer;

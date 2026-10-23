package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"github.com/multica-ai/multica/server/internal/cli"
)

// Asset profiles are opaque JSONB documents at the API layer; the CLI keeps
// that opacity: --data validates JSON locally, --data-file streams a file in
// without inspecting it, and `get` prints the document verbatim.

var assetProfileCmd = &cobra.Command{
	Use:   "asset",
	Short: "Work with asset profiles (structured JSON documents in the workspace)",
}

var assetListCmd = &cobra.Command{
	Use:   "list",
	Short: "List asset profiles in the workspace",
	RunE:  runAssetList,
}

var assetGetCmd = &cobra.Command{
	Use:   "get <id>",
	Short: "Get an asset profile, including its JSON document",
	Args:  exactArgs(1),
	RunE:  runAssetGet,
}

var assetCreateCmd = &cobra.Command{
	Use:   "create",
	Short: "Create an asset profile",
	RunE:  runAssetCreate,
}

var assetUpdateCmd = &cobra.Command{
	Use:   "update <id>",
	Short: "Update an asset profile",
	Args:  exactArgs(1),
	RunE:  runAssetUpdate,
}

var assetDeleteCmd = &cobra.Command{
	Use:   "delete <id>",
	Short: "Delete an asset profile",
	Args:  exactArgs(1),
	RunE:  runAssetDelete,
}

func init() {
	assetProfileCmd.AddCommand(assetListCmd)
	assetProfileCmd.AddCommand(assetGetCmd)
	assetProfileCmd.AddCommand(assetCreateCmd)
	assetProfileCmd.AddCommand(assetUpdateCmd)
	assetProfileCmd.AddCommand(assetDeleteCmd)

	// asset list
	assetListCmd.Flags().String("output", "table", "Output format: table or json")

	// asset get
	assetGetCmd.Flags().String("output", "json", "Output format: json (full document) or table (metadata only)")

	// asset create
	assetCreateCmd.Flags().String("name", "", "Asset profile name (required)")
	assetCreateCmd.Flags().String("description", "", "Asset profile description")
	assetCreateCmd.Flags().String("data", "", "JSON document as a string")
	assetCreateCmd.Flags().String("data-file", "", "Path to a JSON document file. Mutually exclusive with --data.")

	// asset update
	assetUpdateCmd.Flags().String("name", "", "New name")
	assetUpdateCmd.Flags().String("description", "", "New description")
	assetUpdateCmd.Flags().String("data", "", "New JSON document as a string")
	assetUpdateCmd.Flags().String("data-file", "", "Path to a new JSON document file. Mutually exclusive with --data.")

	// asset delete
	assetDeleteCmd.Flags().Bool("yes", false, "Skip confirmation prompt")
}

// resolveAssetDataFlag reads the --data / --data-file pair, enforcing mutual
// exclusion and JSON validity. Returns (document, set, error); set=false
// means neither flag was given so callers can omit the field.
func resolveAssetDataFlag(cmd *cobra.Command) (any, bool, error) {
	inline, _ := cmd.Flags().GetString("data")
	filePath, _ := cmd.Flags().GetString("data-file")
	inlineSet := cmd.Flags().Changed("data")

	if inlineSet && filePath != "" {
		return nil, false, fmt.Errorf("--data and --data-file are mutually exclusive")
	}

	var raw []byte
	switch {
	case filePath != "":
		var err error
		raw, err = os.ReadFile(filePath)
		if err != nil {
			return nil, false, fmt.Errorf("read file for --data-file: %w", err)
		}
	case inlineSet:
		raw = []byte(inline)
	default:
		return nil, false, nil
	}

	var doc any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, false, fmt.Errorf("data must be valid JSON: %w", err)
	}
	if _, ok := doc.(map[string]any); !ok {
		return nil, false, fmt.Errorf("data must be a JSON object")
	}
	return doc, true, nil
}

func runAssetList(cmd *cobra.Command, _ []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}

	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	var profiles []map[string]any
	if err := client.GetJSON(ctx, "/api/asset-profiles", &profiles); err != nil {
		return fmt.Errorf("list asset profiles: %w", err)
	}

	output, _ := cmd.Flags().GetString("output")
	if output == "json" {
		return cli.PrintJSON(os.Stdout, profiles)
	}

	headers := []string{"ID", "NAME", "DESCRIPTION", "UPDATED_AT"}
	rows := make([][]string, 0, len(profiles))
	for _, p := range profiles {
		rows = append(rows, []string{
			strVal(p, "id"),
			strVal(p, "name"),
			strVal(p, "description"),
			strVal(p, "updated_at"),
		})
	}
	cli.PrintTable(os.Stdout, headers, rows)
	return nil
}

func runAssetGet(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}

	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	var profile map[string]any
	if err := client.GetJSON(ctx, "/api/asset-profiles/"+args[0], &profile); err != nil {
		return fmt.Errorf("get asset profile: %w", err)
	}

	output, _ := cmd.Flags().GetString("output")
	if output != "table" {
		return cli.PrintJSON(os.Stdout, profile)
	}

	headers := []string{"ID", "NAME", "DESCRIPTION", "UPDATED_AT"}
	rows := [][]string{{
		strVal(profile, "id"),
		strVal(profile, "name"),
		strVal(profile, "description"),
		strVal(profile, "updated_at"),
	}}
	cli.PrintTable(os.Stdout, headers, rows)
	fmt.Println("Use --output json to read the data document.")
	return nil
}

func runAssetCreate(cmd *cobra.Command, _ []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}

	name, _ := cmd.Flags().GetString("name")
	if name == "" {
		return fmt.Errorf("--name is required")
	}

	body := map[string]any{"name": name}
	if v, _ := cmd.Flags().GetString("description"); v != "" {
		body["description"] = v
	}
	doc, set, err := resolveAssetDataFlag(cmd)
	if err != nil {
		return err
	}
	if set {
		body["data"] = doc
	}

	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	var result map[string]any
	if err := client.PostJSON(ctx, "/api/asset-profiles", body, &result); err != nil {
		return fmt.Errorf("create asset profile: %w", err)
	}
	return cli.PrintJSON(os.Stdout, result)
}

func runAssetUpdate(cmd *cobra.Command, args []string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}

	body := map[string]any{}
	if cmd.Flags().Changed("name") {
		v, _ := cmd.Flags().GetString("name")
		if v == "" {
			return fmt.Errorf("--name cannot be empty")
		}
		body["name"] = v
	}
	if cmd.Flags().Changed("description") {
		v, _ := cmd.Flags().GetString("description")
		body["description"] = v
	}
	doc, set, err := resolveAssetDataFlag(cmd)
	if err != nil {
		return err
	}
	if set {
		body["data"] = doc
	}
	if len(body) == 0 {
		return fmt.Errorf("nothing to update: pass --name, --description, --data, or --data-file")
	}

	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	var result map[string]any
	if err := client.PatchJSON(ctx, "/api/asset-profiles/"+args[0], body, &result); err != nil {
		return fmt.Errorf("update asset profile: %w", err)
	}
	return cli.PrintJSON(os.Stdout, result)
}

func runAssetDelete(cmd *cobra.Command, args []string) error {
	yes, _ := cmd.Flags().GetBool("yes")
	if !yes {
		fmt.Printf("Are you sure you want to delete asset profile %s? This cannot be undone. [y/N] ", args[0])
		reader := bufio.NewReader(os.Stdin)
		answer, _ := reader.ReadString('\n')
		answer = strings.TrimSpace(strings.ToLower(answer))
		if answer != "y" && answer != "yes" {
			fmt.Println("Aborted.")
			return nil
		}
	}

	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}

	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()

	if err := client.DeleteJSON(ctx, "/api/asset-profiles/"+args[0]); err != nil {
		return fmt.Errorf("delete asset profile: %w", err)
	}

	fmt.Printf("Asset profile deleted: %s\n", args[0])
	return nil
}

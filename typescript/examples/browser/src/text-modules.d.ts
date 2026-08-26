// esbuild's built-in text loader: .txt files import as their string content.
declare module "*.txt" {
	const text: string;
	export default text;
}

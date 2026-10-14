default // Initially stopped inventory script.
{
    state_entry()
    {
        llLinksetDataWrite("stopped:boot", "yes");
    }
}
